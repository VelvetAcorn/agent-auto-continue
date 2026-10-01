'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAddress, listBindableAddresses } = require('../lib/remote/network');
const { TokenStore, hashToken } = require('../lib/remote/tokens');
const { FailureLimiter, RequestLimiter } = require('../lib/remote/rate-limit');
const { AuditLog } = require('../lib/remote/audit');
const { ListenerSet, hostAllowed } = require('../lib/remote/server');
const { RemoteControl, readState } = require('../lib/remote');

test('only loopback, Tailscale and private ranges are bindable; wildcard, public and link-local never are', () => {
  for (const [address, kind] of [
    ['127.0.0.1', 'loopback'], ['100.64.0.1', 'tailscale'], ['100.127.255.254', 'tailscale'], ['100.101.102.103', 'tailscale'],
    ['10.0.0.5', 'private'], ['172.16.0.1', 'private'], ['172.31.255.1', 'private'], ['192.168.1.20', 'private'],
    ['fd7a:115c:a1e0::1234', 'tailscale'], ['fd00::1', 'private'], ['fc12:3456::1', 'private']
  ]) assert.equal(classifyAddress(address), kind, address);
  for (const address of ['0.0.0.0', '::', '::1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1', '169.254.1.1', 'fe80::1', 'fe80::1%en0', '2001:4860::8888', 'localhost', '', undefined, '127.0.0.2']) {
    assert.equal(classifyAddress(address), null, String(address));
  }
});

test('bindable address list comes from real interfaces, puts Tailscale first and skips loopback and public', () => {
  const list = listBindableAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    en1: [{ address: '81.2.69.160', family: 'IPv4', internal: false }],
    utun4: [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }, { address: '100.100.1.2', family: 'IPv4', internal: false }]
  });
  assert.deepEqual(list.map((item) => [item.address, item.kind, item.interface]), [
    ['100.100.1.2', 'tailscale', 'utun4'], ['fd7a:115c:a1e0::1', 'tailscale', 'utun4'], ['192.168.1.20', 'private', 'en0']
  ]);
  assert.match(list[0].label, /^Tailscale · 100\.100\.1\.2 \(utun4\)$/);
});

test('listener set refuses wildcard and public addresses before opening anything', async () => {
  let created = 0;
  const set = new ListenerSet({ handle: () => {}, createServer: () => { created++; throw new Error('must not be called'); } });
  for (const address of ['0.0.0.0', '::', '203.0.113.9']) {
    await assert.rejects(set.start(['127.0.0.1', address], 45000), /Refusing to listen/);
  }
  assert.equal(created, 0);
});

test('host header check pins the loopback listener to loopback names and the configured port', () => {
  const loopback = { address: '127.0.0.1', port: 3799 };
  assert.equal(hostAllowed(loopback, '127.0.0.1:3799'), true);
  assert.equal(hostAllowed(loopback, 'localhost:3799'), true);
  assert.equal(hostAllowed(loopback, 'evil.example:3799'), false, 'DNS rebinding name');
  assert.equal(hostAllowed(loopback, '127.0.0.1:80'), false);
  assert.equal(hostAllowed(loopback, '127.0.0.1'), false);
  assert.equal(hostAllowed(loopback, undefined), false);
  const tailnet = { address: '100.100.1.2', port: 3799 };
  assert.equal(hostAllowed(tailnet, '100.100.1.2:3799'), true);
  assert.equal(hostAllowed(tailnet, 'my-mac.tail1234.ts.net:3799'), true);
  assert.equal(hostAllowed(tailnet, 'my-mac:4000'), false);
});

test('tokens are shown once, stored only as digests, verified, and revocable', () => {
  let writes = 0;
  let time = Date.parse('2026-09-30T12:00:00Z');
  const store = new TokenStore({ persist: () => { writes++; }, now: () => time });
  const { token, record } = store.create({ label: "  Ryan's iPhone ", scope: 'control' });
  assert.match(token, /^aac_[A-Za-z0-9_-]{43}$/);
  assert.equal(record.label, "Ryan's iPhone");
  assert.equal(record.hash, undefined, 'public records never include digests');
  const saved = JSON.stringify(store.toJSON());
  assert.doesNotMatch(saved, new RegExp(token.slice(4)), 'plaintext never persists');
  assert.equal(store.toJSON()[0].hash, hashToken(token).toString('hex'));
  assert.equal(store.authenticate(token).id, record.id);
  assert.equal(store.list()[0].lastUsedAt, '2026-09-30T12:00:00.000Z');
  assert.equal(store.authenticate(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(store.authenticate('aac_short'), null);
  assert.equal(store.authenticate(undefined), null);
  const before = writes;
  time += 10_000; store.authenticate(token);
  assert.equal(writes, before, 'last-used writes are throttled');
  time += 60_000; store.authenticate(token);
  assert.equal(writes, before + 1);
  store.revoke(record.id);
  assert.equal(store.authenticate(token), null);
  assert.throws(() => store.revoke(record.id), /not found/);
});

test('token labels and scopes are validated and failed writes roll back', () => {
  const store = new TokenStore();
  for (const label of ['', '   ', 'x'.repeat(61), 'bad\u0007label', 42]) assert.throws(() => store.create({ label }), /Name the device/);
  assert.throws(() => store.create({ label: 'Phone', scope: 'admin' }), /full control or read only/);
  const failing = new TokenStore({ persist: () => { throw new Error('Disk full'); } });
  assert.throws(() => failing.create({ label: 'Phone' }), /Disk full/);
  assert.equal(failing.list().length, 0);
  assert.throws(() => new TokenStore({ records: [{ id: 'x' }] }), /invalid/);
});

test('failed authentication locks out an address, then recovers', () => {
  let time = 0;
  const limiter = new FailureLimiter({ limit: 3, globalLimit: 100, windowMs: 1000, lockMs: 5000, now: () => time });
  assert.equal(limiter.fail('10.0.0.2'), false);
  assert.equal(limiter.fail('10.0.0.2'), false);
  assert.equal(limiter.retryAfter('10.0.0.2'), 0);
  assert.equal(limiter.fail('10.0.0.2'), true);
  assert.equal(limiter.retryAfter('10.0.0.2'), 5);
  assert.equal(limiter.retryAfter('10.0.0.3'), 0, 'other addresses are unaffected');
  time = 5001;
  assert.equal(limiter.retryAfter('10.0.0.2'), 0);
  const global = new FailureLimiter({ limit: 50, globalLimit: 4, now: () => 0 });
  for (let index = 0; index < 4; index++) global.fail(`10.0.0.${index}`);
  assert.ok(global.retryAfter('10.0.0.99') > 0, 'distributed guessing trips the global budget');
});

test('per-token request limiter refills over time', () => {
  let time = 0;
  const limiter = new RequestLimiter({ perMinute: 2, now: () => time });
  assert.equal(limiter.take('a'), 0);
  assert.equal(limiter.take('a'), 0);
  assert.ok(limiter.take('a') > 0);
  assert.equal(limiter.take('b'), 0);
  time = 30_000;
  assert.equal(limiter.take('a'), 0);
});

test('audit log is bounded, strips control characters and survives write failures', () => {
  const log = new AuditLog({ max: 3, persist: () => { throw new Error('Disk full'); }, now: () => 0 });
  for (let index = 0; index < 5; index++) log.record({ action: `action-${index}`, tokenLabel: 'Phone\n\u0000x' });
  assert.deepEqual(log.list().map((entry) => entry.action), ['action-4', 'action-3', 'action-2']);
  assert.equal(log.list()[0].tokenLabel, 'Phone  x');
});

test('remote settings default to off and loopback only, and reject unsafe bind choices', async () => {
  const interfaces = { utun4: [{ address: '100.100.1.2', family: 'IPv4', internal: false }], en0: [{ address: '203.0.113.9', family: 'IPv4', internal: false }] };
  let saved;
  const remote = new RemoteControl({ load: () => undefined, save: (state) => { saved = state; }, getService: () => null, ensureStorage() {}, getStorageError: () => null,
    harnesses: { defaultHarness: 't3', describe: () => [], has: () => false, get() { throw new Error('none'); } }, appInfo: { name: 'test', version: '0' }, networkInterfaces: () => interfaces });
  const state = remote.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.bindAddress, null);
  assert.equal(state.running, false);
  assert.deepEqual(state.interfaces.map((item) => item.address), ['100.100.1.2']);
  for (const bindAddress of ['0.0.0.0', '::', '203.0.113.9', '127.0.0.1', '100.100.9.9', 'localhost']) {
    await assert.rejects(remote.configure({ bindAddress }), /Tailscale or private network address/, bindAddress);
  }
  for (const port of [0, 80, 1023, 65536, 3799.5, 'abc']) await assert.rejects(remote.configure({ port }), /port must be/);
  for (const allowedOrigins of [['*'], ['https://example.com/path'], ['file://x'], 'https://example.com', Array(11).fill('https://a.example')]) {
    await assert.rejects(remote.configure({ allowedOrigins }), /origin/i);
  }
  assert.equal(saved, undefined, 'rejected settings are never persisted');
  await remote.configure({ bindAddress: '100.100.1.2', allowedOrigins: ['https://phone.example'] });
  assert.equal(saved.bindAddress, '100.100.1.2');
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.tokens, []);
});

test('an unreadable remote settings file disables remote control without overwriting it', async () => {
  let writes = 0;
  for (const load of [() => { throw new Error('The local remote-control.json file could not be read.'); }, () => ({ version: 2 }), () => ({ version: 1, enabled: true, port: 3799, bindAddress: null, allowedOrigins: [], tokens: [{ id: 'broken' }] })]) {
    const remote = new RemoteControl({ load, save: () => { writes++; }, getService: () => null, ensureStorage() {}, getStorageError: () => null,
      harnesses: { defaultHarness: 't3', describe: () => [], has: () => false, get() { throw new Error('none'); } }, appInfo: { name: 'test', version: '0' }, networkInterfaces: () => ({}) });
    assert.ok(remote.getState().loadError);
    assert.equal((await remote.start()).length, 0);
    await assert.rejects(remote.configure({ enabled: true }));
    assert.throws(() => remote.createToken({ label: 'Phone' }));
  }
  assert.equal(writes, 0);
  assert.throws(() => readState(null), /invalid/);
});
