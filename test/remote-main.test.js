'use strict';
// Drives the production main.js wiring: desktop IPC, the REST API and MCP share one scheduler.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { appHarness } = require('./app-harness');
const { freePort } = require('./remote-fixture');

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const thread = { id: 'thread', title: 'Harnessed thread', projectId: 'p', updatedAt: '2026-09-30T10:00:00.000Z', settledOverride: null, messages: [] };

// Only T3 Code is registered, so status checks never start real harness processes (claude, codex, osascript).
async function enabledApp(t, options) {
  const app = appHarness([], { extraHarnesses: () => [], ...options });
  app.setResponse(async (url) => url.includes('/threads/') ? json({ thread }) : json({ threads: [thread], projects: [{ id: 'p', title: 'Project' }] }));
  t.after(async () => { await app.emit('before-quit'); });
  const port = await freePort();
  const state = await app.invoke('remote:configure', { enabled: true, port });
  assert.deepEqual(state.listeners.map((listener) => [listener.address, listener.listening]), [['127.0.0.1', true]], 'loopback only by default');
  const { token, record, qrDataUrl } = app.invoke('remote:create-token', { label: 'Phone' });
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { app, port, token, record, qrDataUrl, call };
}

test('remote validation matches the desktop composer path exactly', async (t) => {
  const { app, port, token, call } = await enabledApp(t);
  const mcp = new Client({ name: 'parity', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => mcp.close());
  const valid = { threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00Z', timeZone: 'UTC' };
  const cases = [
    { whenISO: '2020-01-01T00:00:00Z' }, { whenISO: '2099-02-30T12:00:00Z' }, { whenISO: '2099-01-01T12:00' }, { whenISO: 'tomorrow' },
    { message: '' }, { message: '   ' }, { message: 'x'.repeat(4001) }, { threadId: '' }, { threadId: 'x'.repeat(513) }, { timeZone: 'Mars/Olympus' }
  ];
  for (const change of cases) {
    const input = { ...valid, ...change };
    const desktop = await app.invoke('schedule:create', input).then(() => null, (error) => error.message);
    assert.ok(desktop, `desktop rejects ${JSON.stringify(change).slice(0, 60)}`);
    const rest = await call('POST', '/v1/jobs', input);
    assert.equal(rest.status, 400, desktop);
    assert.deepEqual(rest.body.error, { code: 'validation_failed', message: desktop });
    const tool = await mcp.callTool({ name: 'schedule_message', arguments: input });
    assert.equal(tool.isError, true);
    assert.equal(tool.content[0].text, `validation_failed: ${desktop}`);
  }
  assert.equal(app.invoke('jobs:list').total, 0, 'no rejected request created a job');
});

test('remote changes land in the desktop queue, notify open windows and survive restart without plaintext tokens', async (t) => {
  const { app, token, record, qrDataUrl, call } = await enabledApp(t);
  app.windows[0].finishLoad();
  assert.match(qrDataUrl, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(qrDataUrl.split(',')[1], 'base64').toString(), /<svg[^>]*>.*<\/svg>/s);
  const created = await call('POST', '/v1/jobs', { threadId: 'thread', delayMinutes: 20, idempotencyKey: 'restart-check' });
  assert.equal(created.status, 201);
  assert.equal(app.invoke('jobs:list', { view: 'upcoming' }).jobs[0].id, created.body.job.id);
  assert.ok(app.events.some(([name]) => name === 'jobs:changed'), 'the desktop UI refreshes');
  assert.ok(app.events.some(([name]) => name === 'remote:changed'), 'the audit view refreshes');
  const desktopEdit = app.invoke('jobs:edit', created.body.job.id, { threadId: 'thread', message: 'Edited on desktop', whenISO: created.body.job.scheduleAt, timeZone: 'UTC' });
  assert.equal((await call('GET', `/v1/jobs/${created.body.job.id}`)).body.job.message, desktopEdit.message);
  const saved = app.files.get('/fixture/remote-control.json');
  assert.ok(saved);
  assert.doesNotMatch(saved, new RegExp(token.slice(4)), 'only digests are stored');
  const state = app.invoke('remote:get');
  assert.equal(state.tokens[0].id, record.id);
  assert.equal(state.tokens[0].hash, undefined);
  assert.ok(state.tokens[0].lastUsedAt);
  assert.ok(state.audit.some((entry) => entry.action === 'createJob' && entry.tokenLabel === 'Phone'));
  await app.emit('before-quit');

  const restarted = appHarness(JSON.parse(app.files.get('/fixture/jobs.json')).jobs, { extraHarnesses: () => [], extraFiles: { '/fixture/remote-control.json': saved } });
  restarted.setResponse(async (url) => url.includes('/threads/') ? json({ thread }) : json({ threads: [thread], projects: [] }));
  t.after(async () => { await restarted.emit('before-quit'); });
  const again = restarted.invoke('remote:get');
  assert.equal(again.enabled, true);
  // Remote control restarts on the saved port as soon as the app is ready.
  for (let attempt = 0; attempt < 50 && !restarted.invoke('remote:get').running; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  const replay = await fetch(`http://127.0.0.1:${again.port}/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'restart-check' }, body: JSON.stringify({ threadId: 'thread', delayMinutes: 20 }) });
  assert.equal(replay.status, 200, 'a retry after an app restart does not duplicate the job');
  assert.equal(restarted.invoke('jobs:list').total, 1);
  restarted.invoke('remote:revoke-token', record.id);
  assert.equal((await fetch(`http://127.0.0.1:${again.port}/v1/status`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test('quitting the app closes the remote listeners', async (t) => {
  const { app, port, call } = await enabledApp(t);
  assert.equal((await call('GET', '/v1/status')).status, 200);
  await app.emit('before-quit');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/status`));
});
