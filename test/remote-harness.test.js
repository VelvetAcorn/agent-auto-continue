'use strict';
// Proves the remote API passes harness identifiers through a registry-shaped boundary
// (the multi-harness contract from issue #2) and exposes optional continuous-run control (issue #3).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { startRemote } = require('./remote-fixture');
const { createT3HarnessSource } = require('../lib/remote/harnesses');

function twoHarnessRegistry(t3) {
  const opencode = {
    id: 'opencode', label: 'OpenCode', kind: 'cli', conversationNoun: 'session', description: 'Fake CLI harness.',
    capabilities: { canDetectUsageLimit: true, canReportResetTime: true },
    settings: [{ key: 'binary', type: 'text', label: 'Binary path' }],
    async checkConnection() { const error = new Error('OpenCode is not installed.'); Object.assign(error, { code: 'harness_not_installed', details: { binary: 'opencode' }, deliveryUncertain: false }); throw error; },
    async listConversations() { return [{ harness: 'opencode', id: 'ses_1', title: 'CLI session', projectId: 'repo', projectName: 'Repo', updatedAt: null, state: 'unknown', settled: null }]; },
    async probeAvailability() { return { state: 'limited', resetsAt: '2026-10-01T05:00:00.000Z', reason: 'Five-hour limit reached.', source: 'reported', checkedAt: '2026-10-01T01:00:00.000Z' }; }
  };
  const t3Adapter = t3.get('t3');
  const adapters = new Map([['t3', t3Adapter], ['opencode', opencode]]);
  return {
    opencode,
    defaultHarness: 't3',
    describe: () => [...t3.describe(), { id: 'opencode', label: 'OpenCode', kind: 'cli', conversationNoun: 'session', description: opencode.description, capabilities: opencode.capabilities, settings: opencode.settings }],
    has: (id) => adapters.has(id),
    get: (id) => { if (!adapters.has(id)) throw Object.assign(new Error('That agent harness is not available in this version of the app.'), { code: 'unknown_harness' }); return adapters.get(id); }
  };
}

async function start(t) {
  let registry;
  const f = await startRemote({ harnesses: (harness) => { registry = twoHarnessRegistry(createT3HarnessSource(harness.api)); return registry; } });
  t.after(f.close);
  return { ...f, registry };
}

test('harness list, per-harness connection and availability resources', async (t) => {
  const f = await start(t);
  const list = await f.request('GET', '/v1/harnesses');
  assert.equal(list.status, 200);
  assert.equal(list.body.defaultHarness, 't3');
  assert.deepEqual(list.body.harnesses.map((item) => item.id), ['t3', 'opencode']);
  assert.equal(list.body.harnesses[1].settings, undefined, 'setting descriptors stay on the desktop');
  assert.equal(list.body.harnesses[1].capabilities.canDetectUsageLimit, true);
  assert.deepEqual((await f.request('GET', '/v1/harnesses/t3/connection')).body, { harness: 't3', online: true });
  const missing = await f.request('GET', '/v1/harnesses/opencode/connection');
  assert.deepEqual(missing.body, { harness: 'opencode', online: false, error: { code: 'harness_not_installed', message: 'OpenCode is not installed.' } });
  const limited = await f.request('GET', '/v1/harnesses/opencode/availability');
  assert.equal(limited.body.availability.state, 'limited');
  assert.equal(limited.body.availability.resetsAt, '2026-10-01T05:00:00.000Z');
  const unknown = await f.request('GET', '/v1/harnesses/t3/availability');
  assert.deepEqual({ ...unknown.body.availability, checkedAt: 'x' }, { state: 'unknown', resetsAt: null, reason: 'This harness does not report usage limits.', source: 'none', checkedAt: 'x' });
  assert.equal((await f.request('GET', '/v1/harnesses/claude/availability')).body.error.code, 'unknown_harness');
  const status = await f.request('GET', '/v1/status');
  assert.deepEqual(status.body.harnesses.map((item) => [item.id, item.online, item.conversationNoun]), [['t3', true, 'thread'], ['opencode', false, 'session']]);
});

test('harness identifiers pass through to conversations, projects and scheduling', async (t) => {
  const f = await start(t);
  const sessions = await f.request('GET', '/v1/threads?harness=opencode');
  assert.deepEqual(sessions.body.threads.map((thread) => [thread.harness, thread.id]), [['opencode', 'ses_1']]);
  assert.deepEqual((await f.request('GET', '/v1/projects?harness=opencode')).body.projects, [{ harness: 'opencode', id: 'repo', name: 'Repo', threads: 1 }]);
  const received = [];
  const create = f.service.create.bind(f.service);
  f.service.create = (input) => { received.push(input); return create(input); };
  await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 10 } });
  await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 10, harness: 't3' } });
  assert.equal(received[0].harness, undefined, 'omitted harness keeps the job service default');
  assert.equal(received[1].harness, 't3');
  assert.equal((await f.request('POST', '/v1/jobs', { body: { threadId: 'x', delayMinutes: 10, harness: 'nope' } })).body.error.code, 'unknown_harness');
  assert.equal(received.length, 2, 'unknown harnesses are rejected before the job service');
});

test('continuous runs are optional: 501 without a provider, listed and stoppable with one', async (t) => {
  const without = await startRemote();
  t.after(without.close);
  const unsupported = await without.request('GET', '/v1/runs');
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.body.error.code, 'not_supported');
  assert.equal((await without.request('POST', '/v1/runs/run-1/stop')).status, 501);

  const runs = [{ id: 'run-1', harness: 't3', threadId: 'thread-a', state: 'running', turnsSent: 3, turnLimit: 10 }];
  const automation = {
    async listRuns() { return runs; },
    async stopRun(id) { const run = runs.find((item) => item.id === id); if (!run) throw Object.assign(new Error('Schedule was not found.'), { code: 'not_found' }); run.state = 'stopped'; return run; }
  };
  const f = await startRemote({ automation });
  t.after(f.close);
  assert.deepEqual((await f.request('GET', '/v1/status')).body.capabilities, { keepAwake: false, continuousRuns: true, compatibility: false });
  assert.equal((await f.request('GET', '/v1/runs')).body.runs[0].turnsSent, 3);
  assert.equal((await f.request('POST', '/v1/runs/run-1/stop', { token: f.read.token })).status, 403);
  const stopped = await f.request('POST', '/v1/runs/run-1/stop');
  assert.equal(stopped.body.run.state, 'stopped');
  assert.ok(f.remote.getState().audit.some((entry) => entry.action === 'stopRun' && entry.outcome === 'ok' && entry.target === 'run-1'));

  const mcp = new Client({ name: 'runs', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${f.control.token}` } } }));
  t.after(() => mcp.close());
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('list_runs') && names.includes('stop_run'));
  assert.equal((await mcp.callTool({ name: 'stop_run', arguments: { id: 'run-1' } })).structuredContent.run.state, 'stopped');

  const plain = new Client({ name: 'no-runs', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await plain.connect(new StreamableHTTPClientTransport(new URL(`${without.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${without.control.token}` } } }));
  t.after(() => plain.close());
  assert.equal((await plain.listTools()).tools.some((tool) => tool.name.includes('run')), false, 'run tools are hidden without a provider');
});
