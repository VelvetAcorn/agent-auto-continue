'use strict';
// The cross-feature wiring in main.js: the harness registry (#2) behind remote control (#4),
// continuation stop and resume (#3) over REST, and keep-awake (#5) tracking every harness and chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appHarness } = require('./app-harness');
const { freePort } = require('./remote-fixture');
const { createFakeHarness } = require('../tools/fake-harness.cjs');

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const thread = { id: 'thread', title: 'T3 thread', projectId: 'p', updatedAt: '2026-09-30T10:00:00.000Z', settledOverride: null, messages: [], session: null };
const keepAwakeOn = { enabled: true, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 20, maxHours: 12, includeRunningAgents: false };
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function remoteApp(t, options) {
  const app = appHarness([], options);
  app.setResponse(async (url) => url.includes('/threads/') ? json({ thread }) : json({ threads: [thread], projects: [] }));
  t.after(async () => { await app.emit('before-quit'); });
  const port = await app.invoke('remote:configure', { enabled: true, port: await freePort() }).then((state) => state.port);
  const { token } = app.invoke('remote:create-token', { label: 'Phone' });
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test('the remote API lists the production harness registry with capabilities and automation support', async (t) => {
  const { app, call } = await remoteApp(t);
  const listed = await call('GET', '/v1/harnesses');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.defaultHarness, 't3');
  assert.deepEqual(listed.body.harnesses.map((item) => item.id), app.invoke('harnesses:list').harnesses.map((item) => item.id));
  assert.deepEqual(listed.body.harnesses.map((item) => item.id), ['t3', 'opencode', 'claude-code', 'claude-desktop', 'codex', 'codex-desktop']);
  for (const item of listed.body.harnesses) {
    assert.equal(item.settings, undefined, 'setting descriptors stay on the Mac');
    assert.equal(typeof item.automation.multipleTurns.supported, 'boolean', item.id);
    assert.equal(item.capabilities.requiresUnlockedScreen, item.kind === 'desktop-app', item.id);
  }
  assert.equal(listed.body.harnesses.find((item) => item.id === 't3').automation.whenAvailable.supported, false);
  // Live checks of the other harnesses would start real processes, so only T3 Code is probed here.
  assert.equal((await call('GET', '/v1/harnesses/t3/availability')).body.availability.state, 'unknown');
  assert.equal((await call('GET', '/v1/harnesses/nope/availability')).body.error.code, 'unknown_harness');
});

test('a continuation on any harness keeps the Mac awake through its waiting phase, and stopping it over REST releases it', async (t) => {
  const desk = createFakeHarness({ id: 'desk', label: 'Desk App', kind: 'desktop-app', capabilities: { requiresUnlockedScreen: true, requiresAccessibilityPermission: true }, conversations: [{ id: 'conv-d', title: 'Desk session' }] });
  desk.state.availability = { state: 'limited', resetsAt: '2099-01-01T00:00:00.000Z', reason: '', source: 'reported' };
  const { app, call } = await remoteApp(t, { extraHarnesses: () => [desk.adapter] });
  app.invoke('keep-awake:configure', keepAwakeOn);
  assert.equal(app.invoke('keep-awake:get').state, 'off', 'nothing to track yet');

  const created = await call('POST', '/v1/jobs', { harness: 'desk', threadId: 'conv-d', trigger: 'available', continuous: true, idempotencyKey: 'desk-run' });
  assert.equal(created.status, 201);
  const id = created.body.job.id;
  assert.equal(created.body.job.displayStatus, 'waiting');
  await settle();
  const holding = app.invoke('keep-awake:get');
  assert.equal(holding.state, 'armed');
  assert.deepEqual(holding.tasks.map((task) => [task.id, task.harness, task.state, task.detail]), [[`job:${id}`, 'desk', 'waiting', 'Waiting for the agent to be available · turn 1, continuous']]);
  assert.equal(holding.requiresUnlockedScreen, true);
  assert.deepEqual([...app.blockers.values()], ['prevent-display-sleep'], 'a harness that drives an app interface keeps the display on');

  const status = (await call('GET', '/v1/status')).body.keepAwake;
  assert.deepEqual((await call('GET', '/v1/status')).body.capabilities, { keepAwake: true, continuousRuns: true });
  assert.equal(status.state, 'armed');
  assert.equal(status.holding, 'display');
  assert.deepEqual(status.tasks.map((task) => [task.id, task.harness, task.requiresUnlockedScreen]), [[`job:${id}`, 'desk', true]]);
  assert.equal(status.settings, undefined, 'keep-awake settings stay on the Mac');
  assert.equal(status.errors, undefined);

  const runs = await call('GET', '/v1/runs');
  assert.deepEqual(runs.body.runs.map((run) => [run.id, run.harness, run.state, run.status, run.continuous]), [[id, 'desk', 'active', 'waiting', true]]);
  const stopped = await call('POST', `/v1/runs/${id}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.run.state, 'stopped');
  assert.equal(app.invoke('jobs:get', id).automation.state, 'stopped', 'the desktop sees the same stop');
  await settle();
  assert.equal(app.invoke('keep-awake:get').state, 'releasing', 'the last task ending starts the release grace');
  assert.equal(app.trayMenu.some((item) => String(item.label).startsWith('Stop all continuations')), false);
  assert.equal(desk.state.submitted.length, 0);
});

test('stop-all and resume over REST use the same job service as the tray', async (t) => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const at = '2026-10-01T08:00:00.000Z';
  const pausedChain = { id: 'paused', harness: 'fake', commandId: 'c1', messageId: 'm1', threadId: 'conv-1', message: 'Keep going', scheduleAt: at, createdAt: at, timeZone: 'UTC', bufferSeconds: 5, trigger: 'time', status: 'pending', deliveryCertainty: 'not-delivered', chain: { limit: 5, state: 'paused', reasonCode: 'no_progress', reason: 'Three quick turns in a row.', changedAt: at, previousTurns: 3, history: [] } };
  const { app, call } = await remoteApp(t, { extraHarnesses: () => [fake.adapter], rawJobs: JSON.stringify({ version: 4, jobs: [pausedChain] }) });
  const resumed = await call('POST', '/v1/runs/paused/resume');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.run.state, 'active');
  assert.equal(app.invoke('jobs:get', 'paused').automation.state, 'active');
  const second = await call('POST', '/v1/jobs', { harness: 'fake', threadId: 'conv-1', delayMinutes: 30, turnLimit: 4 });
  await settle();
  assert.equal(app.trayMenu.find((item) => String(item.label).startsWith('Stop all continuations')).label, 'Stop all continuations (2)');
  const all = await call('POST', '/v1/runs/stop-all');
  assert.deepEqual(all.body.runs.map((run) => [run.id, run.state]).sort(), [['paused', 'stopped'], [second.body.job.id, 'stopped']].sort());
  await settle();
  assert.equal(app.trayMenu.some((item) => String(item.label).startsWith('Stop all continuations')), false);
  assert.equal(fake.state.submitted.length, 0);
});

test('keep-awake counts a T3 Code job once although both work sources can see it', async () => {
  const app = appHarness([]);
  app.setResponse(async (url) => url.includes('/threads/') ? json({ thread }) : json({ threads: [thread], projects: [] }));
  app.invoke('keep-awake:configure', keepAwakeOn);
  const job = await app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: new Date(Date.now() + 3_600_000).toISOString(), timeZone: 'UTC' });
  await settle();
  const { tasks } = app.invoke('keep-awake:get');
  assert.deepEqual(tasks.map((task) => [task.id, task.source]), [[`job:${job.id}`, 'active-work']]);
  app.invoke('keep-awake:stop');
  await app.emit('will-quit');
  assert.equal(app.blockers.size, 0);
});

test('saving keep-awake settings keeps every saved harness setting', () => {
  const app = appHarness([], { env: { T3_TOKEN: 'test-secret', OPENCODE_SERVER_PASSWORD: '' } });
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { port: 4555 } } });
  app.invoke('keep-awake:configure', keepAwakeOn);
  const saved = JSON.parse(app.files.get('/fixture/config.json'));
  assert.deepEqual(saved.keepAwake, keepAwakeOn);
  assert.deepEqual(saved.harnesses, { opencode: { port: 4555 } });
  assert.equal(app.invoke('settings:get').harnesses.opencode.port.value, 4555);
  app.invoke('keep-awake:stop');
});
