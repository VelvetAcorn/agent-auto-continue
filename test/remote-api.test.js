'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRemote, freePort } = require('./remote-fixture');

const future = (minutes = 60) => new Date(Date.now() + minutes * 60_000).toISOString();

test('every endpoint requires a valid bearer token and failures are audited', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  for (const headers of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer' }, { Authorization: `Bearer ${f.control.token}x` }]) {
    const response = await f.request('GET', '/v1/status', { token: null, headers });
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.equal(response.body.error.code, 'unauthorized');
    assert.match(response.headers.get('www-authenticate'), /^Bearer realm="agent-auto-continue"/);
  }
  assert.equal((await f.request('POST', '/mcp', { token: null, body: {} })).status, 401);
  const denied = f.remote.getState().audit.filter((entry) => entry.action === 'authenticate');
  assert.equal(denied.length, 5);
  assert.ok(denied.every((entry) => entry.outcome === 'denied' && entry.remoteAddress));
  assert.doesNotMatch(JSON.stringify(f.remote.getState()), new RegExp(f.control.token.slice(4)), 'token plaintext never appears in state or audit');
});

test('repeated authentication failures lock the address out with Retry-After, even for a valid token', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await f.request('GET', '/v1/status', { token: 'aac_' + 'x'.repeat(43) })).status, 401);
  const locked = await f.request('GET', '/v1/status');
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_failures');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.ok(f.remote.getState().audit.some((entry) => /locked out/.test(entry.error || '')));
});

test('status reports desktop, storage, harness reachability, queue counts and optional keep-awake', async (t) => {
  let clock = Date.parse('2026-10-01T08:00:00Z');
  const f = await startRemote({ keepAwake: { status: () => ({ available: true, active: false }) }, now: () => clock });
  t.after(f.close);
  const ok = await f.request('GET', '/v1/status');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.harnesses, [{ id: 't3', label: 'T3 Code', conversationNoun: 'thread', online: true, checkedAt: '2026-10-01T08:00:00.000Z' }]);
  assert.equal(ok.body.defaultHarness, 't3');
  assert.deepEqual(ok.body.capabilities, { keepAwake: true, continuousRuns: false });
  assert.deepEqual(ok.body.storage, { ok: true });
  assert.deepEqual(ok.body.jobs, { upcoming: 0, unacknowledgedFailures: 0 });
  assert.deepEqual(ok.body.keepAwake, { available: true, active: false });
  assert.deepEqual(ok.body.caller, { label: "Ryan's iPhone", scope: 'control' });
  assert.equal(ok.body.desktop.version, '0.0.0-test');
  f.harness.online = false;
  f.setStorageError({ code: 'storage_unavailable', message: 'The local jobs.json file could not be read.' });
  // Connection results are reused for 30 seconds so a polling phone does not start harness processes on every request.
  const cached = await f.request('GET', '/v1/status');
  assert.equal(cached.body.harnesses[0].online, true);
  assert.equal(cached.body.harnesses[0].checkedAt, '2026-10-01T08:00:00.000Z');
  assert.equal(cached.body.storage.ok, false, 'storage health is never cached');
  assert.equal((await f.request('GET', '/v1/harnesses/t3/connection')).body.online, false, 'check_connection is always live');
  clock += 30_000;
  const degraded = await f.request('GET', '/v1/status');
  assert.equal(degraded.body.harnesses[0].online, false);
  assert.equal(degraded.body.harnesses[0].checkedAt, '2026-10-01T08:00:30.000Z');
  assert.equal(degraded.body.harnesses[0].error.code, 'connection_refused');
  assert.equal(degraded.body.storage.ok, false);
  const noProvider = await startRemote();
  t.after(noProvider.close);
  assert.equal((await noProvider.request('GET', '/v1/status')).body.keepAwake, null);
});

test('threads and projects pass harness identifiers through and filter like the desktop picker', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const active = await f.request('GET', '/v1/threads');
  assert.deepEqual(active.body.threads.map((thread) => thread.id), ['thread-a'], 'settled and archived hidden by default');
  assert.equal(active.body.threads[0].harness, 't3');
  assert.equal(active.body.threads[0].projectName, 'Parser');
  const all = await f.request('GET', '/v1/threads?showSettled=true');
  assert.deepEqual(all.body.threads.map((thread) => thread.id), ['thread-b', 'thread-a']);
  assert.deepEqual((await f.request('GET', '/v1/threads?showSettled=true&query=DOCS')).body.threads.map((thread) => thread.id), ['thread-b']);
  assert.deepEqual((await f.request('GET', '/v1/threads?showSettled=true&projectId=project-1')).body.threads.map((thread) => thread.id), ['thread-a']);
  assert.equal((await f.request('GET', '/v1/threads?showSettled=true&limit=1')).body.total, 2);
  assert.deepEqual((await f.request('GET', '/v1/projects')).body.projects, [{ harness: 't3', id: 'project-2', name: 'Docs', threads: 1 }, { harness: 't3', id: 'project-1', name: 'Parser', threads: 1 }]);
  assert.equal((await f.request('GET', '/v1/threads?harness=opencode')).body.error.code, 'unknown_harness');
  for (const query of ['limit=0', 'limit=abc', 'showSettled=yes', 'unknown=1', 'limit=1&limit=2']) {
    const response = await f.request('GET', `/v1/threads?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(response.body.error.code, 'validation_failed');
  }
  f.harness.online = false;
  const offline = await f.request('GET', '/v1/threads');
  assert.equal(offline.status, 502);
  assert.equal(offline.body.error.code, 'harness_unavailable');
  assert.equal(offline.body.error.details.upstream.code, 'connection_refused');
});

test('full job lifecycle: create, read, list, edit, cancel, with conflicts and audit', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const whenISO = future(30);
  const created = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', whenISO, timeZone: 'Europe/London' } });
  assert.equal(created.status, 201);
  const { job } = created.body;
  assert.equal(created.body.replayed, false);
  assert.equal(job.message, 'Continue', 'the default matches the desktop composer');
  assert.equal(job.harness, 't3');
  assert.equal(job.threadTitle, 'Refactor parser');
  assert.equal(job.scheduleAt, whenISO);
  assert.equal(job.bufferSeconds, 5);
  assert.equal((await f.request('GET', `/v1/jobs/${job.id}`)).body.job.id, job.id);
  const upcoming = await f.request('GET', '/v1/jobs?view=upcoming');
  assert.equal(upcoming.body.total, 1);
  assert.equal(upcoming.body.jobs[0].deliveryStatus, 'pending');
  const edited = await f.request('PATCH', `/v1/jobs/${job.id}`, { body: { message: 'Proceed' } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.job.message, 'Proceed');
  assert.equal(edited.body.job.scheduleAt, whenISO, 'omitted fields keep their saved values');
  const moved = await f.request('PATCH', `/v1/jobs/${job.id}`, { body: { delayMinutes: 90 } });
  assert.ok(Date.parse(moved.body.job.scheduleAt) > Date.parse(whenISO));
  assert.equal((await f.request('PATCH', `/v1/jobs/${job.id}`, { body: {} })).status, 400);
  assert.equal((await f.request('PATCH', `/v1/jobs/${job.id}`, { body: { whenISO, delayMinutes: 5 } })).body.error.message, 'Provide either whenISO or delayMinutes, not both.');
  const canceled = await f.request('POST', `/v1/jobs/${job.id}/cancel`);
  assert.equal(canceled.body.job.status, 'canceled');
  assert.equal(f.service.get(job.id).status, 'canceled', 'the desktop is the source of truth');
  const again = await f.request('POST', `/v1/jobs/${job.id}/cancel`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'invalid_state');
  assert.equal((await f.request('PATCH', `/v1/jobs/${job.id}`, { body: { message: 'x' } })).status, 409);
  assert.equal((await f.request('POST', `/v1/jobs/${job.id}/acknowledge`)).status, 409);
  assert.equal((await f.request('GET', '/v1/jobs/missing')).status, 404);
  assert.equal((await f.request('GET', '/v1/jobs/missing')).body.error.code, 'job_not_found');
  assert.equal((await f.request('GET', '/v1/jobs?view=history&status=canceled')).body.total, 1);
  assert.equal((await f.request('GET', '/v1/jobs?view=sideways')).body.error.message, 'Invalid schedule filter.');
  assert.equal((await f.request('GET', '/v1/jobs?limit=501')).body.error.message, 'Invalid pagination.');
  const actions = f.remote.getState().audit.filter((entry) => entry.transport === 'http').map((entry) => `${entry.action}:${entry.outcome}`);
  assert.deepEqual(actions.reverse(), ['createJob:ok', 'editJob:ok', 'editJob:ok', 'editJob:error', 'editJob:error', 'cancelJob:ok', 'cancelJob:error', 'editJob:error', 'acknowledgeJob:error']);
  assert.ok(f.remote.getState().audit.every((entry) => entry.transport !== 'http' || entry.tokenLabel === "Ryan's iPhone"));
  assert.equal(f.harness.dispatches, 0);
});

test('acknowledge and reconcile reuse the job service rules and never resend', async (t) => {
  const base = { commandId: 'c', threadId: 'thread-a', message: 'Continue', scheduleAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z', bufferSeconds: 5 };
  const f = await startRemote({ jobs: [{ ...base, id: 'failed', messageId: 'm1', status: 'failed', deliveryCertainty: 'not-delivered' }, { ...base, id: 'uncertain', messageId: 'm2', status: 'unconfirmed' }] });
  t.after(f.close);
  const acknowledged = await f.request('POST', '/v1/jobs/failed/acknowledge');
  assert.equal(acknowledged.status, 200);
  assert.ok(acknowledged.body.job.acknowledgedAt);
  assert.equal((await f.request('POST', '/v1/jobs/failed/reconcile')).status, 409);
  const unchanged = await f.request('POST', '/v1/jobs/uncertain/reconcile');
  assert.equal(unchanged.body.job.deliveryStatus, 'unconfirmed');
  assert.ok(unchanged.body.job.lastReconciledAt);
  f.harness.threads[0].messages.push({ id: 'm2', role: 'user', createdAt: '2026-01-01T10:00:00Z' });
  const confirmed = await f.request('POST', '/v1/jobs/uncertain/reconcile');
  assert.equal(confirmed.body.job.deliveryStatus, 'sent');
  f.harness.online = false;
  assert.equal((await f.request('POST', '/v1/jobs/uncertain/reconcile')).status, 409);
  assert.equal(f.harness.dispatches, 0);
});

test('idempotency keys make retried creates safe, including concurrent retries', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const body = { threadId: 'thread-a', delayMinutes: 45 };
  const first = await f.request('POST', '/v1/jobs', { body, headers: { 'Idempotency-Key': 'phone-retry-1' } });
  const retry = await f.request('POST', '/v1/jobs', { body, headers: { 'Idempotency-Key': 'phone-retry-1' } });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.job.id, first.body.job.id);
  const conflict = await f.request('POST', '/v1/jobs', { body: { ...body, message: 'Different' }, headers: { 'Idempotency-Key': 'phone-retry-1' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  const concurrent = await Promise.all([1, 2, 3].map(() => f.request('POST', '/v1/jobs', { body: { ...body, idempotencyKey: 'burst' } })));
  assert.equal(new Set(concurrent.map((response) => response.body.job.id)).size, 1);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 200, 201]);
  assert.equal(f.service.jobs.length, 2);
  const otherDevice = await f.request('POST', '/v1/jobs', { token: f.control.token, body, headers: { 'Idempotency-Key': 'bad key!' } });
  assert.equal(otherDevice.body.error.code, 'invalid_idempotency_key');
  assert.equal((await f.request('POST', '/v1/jobs', { body: { ...body, idempotencyKey: 'a' }, headers: { 'Idempotency-Key': 'b' } })).status, 400);
  assert.ok(f.files.saved.idempotency.some((entry) => entry.jobId === first.body.job.id), 'keys survive restart');
  const creates = f.remote.getState().audit.filter((entry) => entry.action === 'createJob').map((entry) => entry.outcome);
  assert.equal(creates.filter((outcome) => outcome === 'ok').length, 2, 'only real creations are logged as done');
  assert.ok(creates.filter((outcome) => outcome === 'replayed').length >= 3);
});

test('read-only tokens can read but every mutation is denied and audited', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const created = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30 } });
  assert.equal((await f.request('GET', '/v1/jobs', { token: f.read.token })).status, 200);
  for (const [method, path, body] of [['POST', '/v1/jobs', { threadId: 'thread-a', delayMinutes: 5 }], ['PATCH', `/v1/jobs/${created.body.job.id}`, { message: 'x' }], ['POST', `/v1/jobs/${created.body.job.id}/cancel`]]) {
    const response = await f.request(method, path, { token: f.read.token, body });
    assert.equal(response.status, 403, path);
    assert.equal(response.body.error.code, 'insufficient_scope');
  }
  assert.equal(f.service.get(created.body.job.id).status, 'pending');
  assert.equal(f.remote.getState().audit.filter((entry) => entry.outcome === 'denied' && entry.tokenLabel === 'Dashboard').length, 3);
});

test('revoking a token takes effect on the very next request', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  assert.equal((await f.request('GET', '/v1/status')).status, 200);
  f.remote.revokeToken(f.control.record.id);
  assert.equal((await f.request('GET', '/v1/status')).status, 401);
  assert.ok(f.remote.getState().audit.some((entry) => entry.action === 'token_revoked' && entry.tokenLabel === "Ryan's iPhone"));
});

test('storage failures block remote mutations with 503 while reads continue', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  f.setStorageError({ code: 'storage_unavailable', message: 'The local jobs.json file could not be read. Restore or repair it before restarting.' });
  const response = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30 } });
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'storage_unavailable');
  assert.equal((await f.request('GET', '/v1/jobs')).status, 200);
});

test('transport hardening: host, origin/CORS, size, media type, JSON, routing', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const http = require('node:http');
  const raw = (options, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, ...options }, (res) => { let data = ''; res.on('data', (chunk) => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject);
    req.end(body);
  });
  const rebound = await raw({ path: '/v1/status', headers: { Host: `attacker.example:${f.port}`, Authorization: `Bearer ${f.control.token}` } });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.error.code, 'host_not_allowed');
  const crossOrigin = await f.request('GET', '/v1/status', { headers: { Origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null, 'no CORS by default');
  await f.remote.configure({ allowedOrigins: ['https://phone.example'] });
  const preflight = await f.request('OPTIONS', '/v1/jobs', { token: null, headers: { Origin: 'https://phone.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://phone.example');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  const allowed = await f.request('GET', '/v1/status', { headers: { Origin: 'https://phone.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://phone.example');
  const huge = await f.request('POST', '/v1/jobs', { raw: JSON.stringify({ threadId: 'thread-a', message: 'x'.repeat(70_000) }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(huge.status, 413);
  assert.equal((await f.request('POST', '/v1/jobs', { raw: 'threadId=thread-a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await f.request('POST', '/v1/jobs', { raw: '{nope', headers: { 'Content-Type': 'application/json' } })).body.error.code, 'invalid_json');
  assert.equal((await f.request('POST', '/v1/jobs', { raw: '[]', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 5, surprise: true } })).status, 400);
  assert.equal((await f.request('POST', '/v1/jobs/abc/cancel', { body: { reason: 'x' } })).status, 400);
  assert.equal((await f.request('PATCH', '/v1/jobs/abc', { body: { id: 'other', message: 'x' } })).status, 400);
  const notFound = await f.request('GET', '/v2/anything');
  assert.equal(notFound.status, 404);
  const wrongMethod = await f.request('DELETE', '/v1/jobs');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
});

test('an unavailable private address is reported and retried without affecting loopback', async (t) => {
  // 100.64.0.1 is a valid Tailscale-range address that is not on this machine, so binding fails like a disconnected tailnet.
  const f = await startRemote({ networkInterfaces: () => ({ utun9: [{ address: '100.64.0.1', family: 'IPv4', internal: false }] }) });
  t.after(f.close);
  const state = await f.remote.configure({ bindAddress: '100.64.0.1' });
  assert.deepEqual(state.listeners.map((listener) => [listener.address, listener.listening]), [['127.0.0.1', true], ['100.64.0.1', false]]);
  assert.match(state.listeners[1].error, /not available/);
  assert.equal(f.timers.at(-1).ms, 30_000, 'a retry is scheduled');
  assert.equal((await f.request('GET', '/v1/status')).status, 200, 'loopback keeps serving');
  await f.timers.at(-1).fn();
  assert.equal(f.remote.getState().listeners[1].listening, false);
  const off = await f.remote.configure({ enabled: false });
  assert.equal(off.running, false);
  await assert.rejects(fetch(`${f.base}/v1/status`));
});

test('port conflicts surface a clear listener error', async (t) => {
  const net = require('node:net');
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const f = await startRemote({ enabled: false });
  t.after(f.close);
  const state = await f.remote.configure({ enabled: true, port });
  assert.equal(state.running, false);
  assert.match(state.listeners[0].error, /already in use/);
});

test('R3: host, origin and rate-limit rejections are audited once per address per minute without credentials', async (t) => {
  let time = Date.now();
  const f = await startRemote({ now: () => time });
  t.after(f.close);
  const http = require('node:http');
  const rebind = () => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, path: '/v1/status', headers: { Host: `attacker.example:${f.port}`, Authorization: `Bearer ${f.control.token}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  const rejections = () => f.remote.getState().audit.filter((entry) => entry.action === 'reject_request');
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(await rebind(), 403);
  assert.equal(rejections().length, 1, 'repeats from one address are collapsed');
  assert.match(rejections()[0].error, /^host_not_allowed: /);
  assert.equal(rejections()[0].outcome, 'denied');
  assert.equal(rejections()[0].remoteAddress, '127.0.0.1');
  time += 61_000;
  await rebind();
  assert.equal(rejections().length, 2);
  assert.match(rejections()[0].error, /\(2 similar requests not logged\)$/);

  assert.equal((await f.request('GET', '/v1/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.match(rejections()[0].error, /^origin_not_allowed: /);

  let status = 200;
  for (let attempt = 0; attempt < 245 && status !== 429; attempt++) status = (await f.request('GET', '/v1/jobs?limit=1', { token: f.read.token })).status;
  assert.equal(status, 429);
  const limited = rejections()[0];
  assert.match(limited.error, /^rate_limited: /);
  assert.equal(limited.tokenLabel, 'Dashboard', 'the authenticated device is named');
  const log = JSON.stringify(f.remote.getState().audit);
  for (const token of [f.control.token, f.read.token]) assert.equal(log.includes(token.slice(4)), false, 'no credentials are logged');
});
