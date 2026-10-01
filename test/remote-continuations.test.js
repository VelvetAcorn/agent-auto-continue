'use strict';
// Remote stop, stop-all and resume of automatic continuations (issues #3 and #4), backed by the real job service.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { createContinuationRuns } = require('../lib/remote/continuations');
const { toRemoteError } = require('../lib/remote/errors');
const { HarnessError } = require('../lib/harnesses/errors');
const { startRemote } = require('./remote-fixture');

const paused = (id, overrides = {}) => ({
  id, harness: 't3', commandId: `c-${id}`, messageId: `m-${id}`, threadId: 'thread-a', threadTitle: 'Refactor parser', message: 'Keep going',
  scheduleAt: '2026-10-01T08:00:00.000Z', createdAt: '2026-10-01T08:00:00.000Z', timeZone: 'UTC', bufferSeconds: 5, trigger: 'time',
  status: 'pending', deliveryCertainty: 'not-delivered',
  chain: { limit: null, state: 'paused', reasonCode: 'user_activity', reason: 'New user activity appeared. Resume to keep continuing.', changedAt: '2026-10-01T09:00:00.000Z', previousTurns: 1, history: [] },
  ...overrides
});

async function remoteWithRuns(t, options = {}) {
  const f = await startRemote({ automation: createContinuationRuns, ...options });
  t.after(f.close);
  return f;
}

test('continuations can be started, listed, stopped, stopped all and resumed over REST', async (t) => {
  const f = await remoteWithRuns(t, { jobs: { version: 4, jobs: [paused('paused-run'), paused('uncertain-run', { status: 'unconfirmed', deliveryCertainty: 'unknown', dispatchAttemptedAt: '2026-10-01T08:00:05.000Z' })] } });
  assert.deepEqual((await f.request('GET', '/v1/status')).body.capabilities, { keepAwake: false, continuousRuns: true, compatibility: false });

  // T3 Code reports turn completion, so it can run several turns, but it cannot start when available.
  const continuous = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30, continuous: true, idempotencyKey: 'night-run' } });
  assert.equal(continuous.status, 201);
  assert.equal(continuous.body.job.automation.unlimited, true);
  const limited = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 45, turnLimit: 3 } });
  assert.equal(limited.body.job.automation.limit, 3);
  const plain = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 50 } });
  assert.equal(plain.body.job.automation, null);
  const replay = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30, continuous: true, idempotencyKey: 'night-run' } });
  assert.equal(replay.status, 200, 'an idempotent retry returns the original continuation');
  assert.equal(replay.body.job.id, continuous.body.job.id);
  const unsupported = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', trigger: 'available' } });
  assert.equal(unsupported.status, 400);
  assert.match(unsupported.body.error.message, /does not report usage limits/);
  const zero = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 5, turnLimit: 0 } });
  assert.equal(zero.status, 400, 'the schema rejects a zero turn limit before the job service');

  const listed = await f.request('GET', '/v1/runs');
  assert.deepEqual(listed.body.runs.map((run) => [run.id, run.state, run.continuous, run.turnLimit]).sort(), [
    [continuous.body.job.id, 'active', true, null], [limited.body.job.id, 'active', false, 3], ['paused-run', 'paused', true, null], ['uncertain-run', 'paused', true, null]
  ].sort(), 'plain schedules are not runs');
  const pausedRun = listed.body.runs.find((run) => run.id === 'paused-run');
  assert.equal(pausedRun.reasonCode, 'user_activity');
  assert.equal(pausedRun.canResume, true);
  assert.equal(listed.body.runs.find((run) => run.id === 'uncertain-run').canResume, false);

  assert.equal((await f.request('POST', `/v1/runs/${continuous.body.job.id}/stop`, { token: f.read.token })).status, 403);
  const stopped = await f.request('POST', `/v1/runs/${continuous.body.job.id}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.run.state, 'stopped');
  assert.equal(f.service.get(continuous.body.job.id).status, 'canceled', 'the unsent turn is canceled');
  const again = await f.request('POST', `/v1/runs/${continuous.body.job.id}/stop`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'invalid_state');
  assert.equal((await f.request('POST', `/v1/runs/${plain.body.job.id}/stop`)).body.error.code, 'run_not_found');
  assert.equal((await f.request('POST', '/v1/runs/missing/stop')).status, 404);

  const refused = await f.request('POST', '/v1/runs/uncertain-run/resume');
  assert.equal(refused.status, 409, 'resume is refused while delivery is unconfirmed');
  assert.match(refused.body.error.message, /Check delivery/);
  const resumed = await f.request('POST', '/v1/runs/paused-run/resume');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.run.state, 'active');
  assert.equal((await f.request('POST', '/v1/runs/paused-run/resume')).body.error.code, 'invalid_state');

  const all = await f.request('POST', '/v1/runs/stop-all');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.runs.map((run) => [run.id, run.state]).sort(), [[limited.body.job.id, 'stopped'], ['paused-run', 'stopped'], ['uncertain-run', 'stopped']].sort());
  assert.deepEqual((await f.request('GET', '/v1/runs')).body.runs, []);
  assert.equal(f.service.get(plain.body.job.id).status, 'pending', 'stop-all leaves plain schedules alone');
  assert.equal((await f.request('POST', '/v1/runs/stop-all')).body.runs.length, 0);
  const audit = f.remote.getState().audit;
  for (const action of ['stopRun', 'resumeRun', 'stopAllRuns']) assert.ok(audit.some((entry) => entry.action === action && entry.outcome === 'ok'), action);
  assert.equal(f.harness.dispatches, 0);
});

test('stopping and resuming need writable storage', async (t) => {
  const f = await remoteWithRuns(t, { jobs: { version: 4, jobs: [paused('paused-run')] } });
  f.setStorageError({ code: 'storage_unavailable', message: 'The local jobs.json file could not be read.' });
  for (const route of ['/v1/runs/paused-run/stop', '/v1/runs/paused-run/resume', '/v1/runs/stop-all']) {
    const response = await f.request('POST', route);
    assert.equal(response.status, 503, route);
    assert.equal(response.body.error.code, 'storage_unavailable');
  }
  assert.equal(f.service.get('paused-run').chain.state, 'paused');
});

test('the MCP server offers every run tool, and read-only tokens only list runs', async (t) => {
  const f = await remoteWithRuns(t, { jobs: { version: 4, jobs: [paused('paused-run'), paused('second-run')] } });
  const connect = async (token) => {
    const client = new Client({ name: 'runs', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    t.after(() => client.close());
    return client;
  };
  const control = await connect(f.control.token);
  const names = (await control.listTools()).tools.map((tool) => tool.name);
  for (const name of ['list_runs', 'stop_run', 'stop_all_runs', 'resume_run']) assert.ok(names.includes(name), name);
  const schedule = (await control.listTools()).tools.find((tool) => tool.name === 'schedule_message');
  assert.deepEqual(['trigger', 'turnLimit', 'continuous'].filter((key) => schedule.inputSchema.properties[key]), ['trigger', 'turnLimit', 'continuous']);
  assert.equal((await control.callTool({ name: 'resume_run', arguments: { id: 'paused-run' } })).structuredContent.run.state, 'active');
  assert.equal((await control.callTool({ name: 'stop_run', arguments: { id: 'paused-run' } })).structuredContent.run.state, 'stopped');
  assert.deepEqual((await control.callTool({ name: 'stop_all_runs', arguments: {} })).structuredContent.runs.map((run) => run.id), ['second-run']);
  const read = await connect(f.read.token);
  assert.deepEqual((await read.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('run')), ['list_runs']);
});

test('a provider without stop-all or resume hides those operations, and none at all answers 501', async (t) => {
  const partial = await startRemote({ automation: { async listRuns() { return []; }, async stopRun() { return {}; } } });
  t.after(partial.close);
  assert.equal((await partial.request('POST', '/v1/runs/stop-all')).status, 501);
  assert.equal((await partial.request('POST', '/v1/runs/x/resume')).status, 501);
  const none = await startRemote();
  t.after(none.close);
  for (const [method, route] of [['GET', '/v1/runs'], ['POST', '/v1/runs/x/stop'], ['POST', '/v1/runs/stop-all'], ['POST', '/v1/runs/x/resume']]) {
    assert.equal((await none.request(method, route)).body.error.code, 'not_supported', route);
  }
});

test('harness error codes keep their meaning in remote errors', async (t) => {
  const cases = {
    conversation_busy: 409, awaiting_input: 409, owned_by_other_harness: 409,
    screen_locked: 503, permission_required: 503, usage_limited: 503,
    connection_refused: 502, harness_not_installed: 502, timeout: 502
  };
  for (const [code, status] of Object.entries(cases)) {
    const failure = toRemoteError(new HarnessError(code, `Harness said ${code}.`, { harness: 'claude-desktop' }));
    assert.equal(failure.status, status, code);
    assert.equal(failure.code, status === 502 ? 'harness_unavailable' : code, code);
    assert.equal(failure.details.upstream.code, code);
  }
  assert.equal(toRemoteError(new HarnessError('conversation_not_found', 'Gone.')).code, 'thread_not_found');
  assert.equal(toRemoteError(new HarnessError('unknown_harness', 'Nope.')).status, 400);

  // Over HTTP, a locked Mac is a 503 with a Retry-After that matches how often continuations check again.
  const locked = await startRemote({
    harnesses: () => ({
      defaultHarness: 'desk', describe: () => [{ id: 'desk', label: 'Desk', conversationNoun: 'session', capabilities: {} }], has: (id) => id === 'desk',
      get: () => ({ async checkConnection() { return { ok: true }; }, async listConversations() { throw new HarnessError('screen_locked', 'The Mac is locked, so Desk cannot be driven.'); } })
    })
  });
  t.after(locked.close);
  const response = await locked.request('GET', '/v1/threads');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'screen_locked');
  assert.equal(response.headers.get('retry-after'), '60');
});
