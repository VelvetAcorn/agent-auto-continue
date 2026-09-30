'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient, toErrorInfo } = require('../lib/api-client');
function client(fetchImpl, overrides = {}) {
  return createApiClient({ getConfig: () => ({ httpPort: 3773 }), getToken: () => 'test-secret', fetchImpl, ...overrides });
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('HTML response produces actionable, sanitized error instead of parser details', async () => {
  const api = client(async () => new Response('<!doctype html><html>test-secret</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(api.fetchSnapshot(), error => {
    const info = toErrorInfo(error);
    assert.equal(info.code, 'unexpected_response_format');
    assert.match(info.message, /webpage.*connection settings/i);
    assert.equal(info.deliveryUncertain, false);
    assert.doesNotMatch(JSON.stringify(info), /test-secret|doctype|Unexpected token/);
    return true;
  });
});

test('dispatch only confirms the verified nonnegative sequence result', async () => {
  for (const payload of [null, {}, { ok: true }, { sequence: -1 }, { sequence: 1.5 }]) {
    await assert.rejects(client(async () => json(payload)).dispatch({}), error => error.code === 'unsupported_response_shape' && error.deliveryUncertain);
  }
  assert.deepEqual(await client(async () => json({ sequence: 0 })).dispatch({}), { sequence: 0 });
});

test('HTML, malformed JSON and empty POST responses leave delivery uncertain', async () => {
  for (const body of ['<!doctype html>', '{invalid', '']) {
    await assert.rejects(client(async () => new Response(body)).dispatch({}), error => error.deliveryUncertain === true);
  }
});

test('authentication failure is known rejection and raw server body is suppressed', async () => {
  await assert.rejects(client(async () => json({ error: 'test-secret' }, 401)).dispatch({}), error => {
    assert.equal(error.code, 'authentication_rejected');
    assert.equal(error.deliveryUncertain, false);
    assert.doesNotMatch(JSON.stringify(toErrorInfo(error)), /test-secret/);
    return true;
  });
});

test('credentials and transport failures are classified without exposing fetch messages', async () => {
  let called = false;
  await assert.rejects(client(async () => { called = true; }, { getToken: () => '' }).fetchSnapshot(), { code: 'missing_credentials' });
  assert.equal(called, false);
  await assert.rejects(client(async () => { throw new Error('test-secret'); }).dispatch({}), error => error.code === 'connection_refused' && error.deliveryUncertain && !error.message.includes('test-secret'));
});

test('timeout aborts and returns a useful structured error', async () => {
  const api = client((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), { timeoutMs: 5 });
  await assert.rejects(api.fetchSnapshot(), { code: 'timeout', deliveryUncertain: false });
});

test('API stays on loopback and encodes thread IDs as one path segment', async () => {
  let url;
  const api = client(async (value, options) => {
    url = value;
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    return json({ thread: { id: '../strange?id', messages: [] } });
  });
  await api.fetchThread('../strange?id');
  assert.equal(url, 'http://127.0.0.1:3773/api/orchestration/threads/..%2Fstrange%3Fid?turnLimit=200');
});
