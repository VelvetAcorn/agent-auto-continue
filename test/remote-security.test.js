'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAddress, listBindableAddresses } = require('../lib/remote/network');
const { TokenStore, hashToken } = require('../lib/remote/tokens');
const { FailureLimiter, RequestLimiter } = require('../lib/remote/rate-limit');
const { AuditLog } = require('../lib/remote/audit');
const { ListenerSet, hostAllowed } = require('../lib/remote/server');
const { RemoteControl, readState } = require('../lib/remote');

test('only loopback and Tailscale ranges are bindable; local-network, wildcard, public and link-local addresses never are', () => {
  for (const [address, kind] of [
    ['127.0.0.1', 'loopback'], ['100.64.0.1', 'tailscale'], ['100.127.255.254', 'tailscale'], ['100.101.102.103', 'tailscale'], ['fd7a:115c:a1e0::1234', 'tailscale']
  ]) assert.equal(classifyAddress(address), kind, address);
  for (const address of ['10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.20', 'fd00::1', 'fc12:3456::1',
    '0.0.0.0', '::', '::1', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1', '169.254.1.1', 'fe80::1', 'fe80::1%en0', '2001:4860::8888', 'localhost', '', undefined, '127.0.0.2']) {
    assert.equal(classifyAddress(address), null, String(address));
  }
});

test('bindable addresses are Tailscale addresses on a tunnel interface only, IPv4 first', () => {
  const list = listBindableAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
    en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }, { address: 'fd00::20', family: 'IPv6', internal: false }],
    en1: [{ address: '81.2.69.160', family: 'IPv4', internal: false }, { address: '10.0.0.7', family: 'IPv4', internal: false }],
    // A phone hotspot's carrier-grade NAT uses the same 100.64.0.0/10 range on an ordinary interface.
    en5: [{ address: '100.72.10.4', family: 'IPv4', internal: false }],
    utun4: [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }, { address: '100.100.1.2', family: 'IPv4', internal: false }]
  });
  assert.deepEqual(list.map((item) => [item.address, item.kind, item.interface]), [['100.100.1.2', 'tailscale', 'utun4'], ['fd7a:115c:a1e0::1', 'tailscale', 'utun4']]);
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
  for (const bindAddress of ['0.0.0.0', '::', '203.0.113.9', '127.0.0.1', '100.100.9.9', 'localhost', '192.168.1.20', '10.0.0.5', '172.16.4.4', 'fd00::1']) {
    await assert.rejects(remote.configure({ bindAddress }), /Choose a Tailscale address currently on this Mac/, bindAddress);
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

test('a saved local-network listener from an earlier version is dropped at launch: loopback stays, with a notice and an audit entry', async () => {
  const interfaces = { en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }], utun4: [{ address: '100.100.1.2', family: 'IPv4', internal: false }] };
  const options = (load, save, notify = () => {}) => ({ load, save, notify, getService: () => null, ensureStorage() {}, getStorageError: () => null, now: () => Date.parse('2026-10-01T08:00:00Z'),
    harnesses: { defaultHarness: 't3', describe: () => [], has: () => false, get() { throw new Error('none'); } }, appInfo: { name: 'test', version: '0' }, networkInterfaces: () => interfaces });
  for (const lan of ['192.168.1.20', '10.0.0.5', '172.20.1.1', 'fd00::1']) {
    let saved;
    const notified = [];
    const earlier = { version: 1, enabled: true, port: 3799, bindAddress: lan, allowedOrigins: [], tokens: [], audit: [] };
    const remote = new RemoteControl(options(() => earlier, (state) => { saved = state; }, (...args) => notified.push(args)));
    const state = remote.getState();
    assert.equal(state.enabled, true, 'remote control stays on');
    assert.equal(state.bindAddress, null, lan);
    assert.equal(saved.bindAddress, null, 'the migration is saved');
    assert.deepEqual([state.notices[0].code, state.notices[0].address], ['lan_bind_removed', lan]);
    assert.match(state.notices[0].message, /no longer listens on .* still listens on 127\.0\.0\.1/);
    assert.deepEqual(saved.notices, [...state.notices].reverse());
    assert.deepEqual([state.audit[0].action, state.audit[0].target, state.audit[0].transport], ['lan_bind_removed', lan, 'desktop']);
    assert.equal(notified.length, 1);
    assert.ok(!state.interfaces.some((item) => item.address === lan), 'the old address is not offered again');
    assert.deepEqual(state.interfaces.map((item) => item.kind), ['tailscale'], 'Network access offers Tailscale only, so the window has no local-network option to warn about');
    // A second launch from the saved file changes nothing more.
    const again = new RemoteControl(options(() => saved, () => { throw new Error('must not save'); }, () => { throw new Error('must not notify'); }));
    assert.equal(again.getState().bindAddress, null);
    assert.equal(again.getState().notices.length, 1);
  }
  // A Tailscale address is kept as it is, even while Tailscale is disconnected.
  let writes = 0;
  const kept = new RemoteControl(options(() => ({ version: 1, enabled: true, port: 3799, bindAddress: '100.90.1.1', allowedOrigins: [], tokens: [] }), () => { writes++; }));
  assert.equal(kept.getState().bindAddress, '100.90.1.1');
  assert.deepEqual(kept.getState().interfaces.map((item) => [item.address, item.kind, item.unavailable === true]), [['100.100.1.2', 'tailscale', false], ['100.90.1.1', 'tailscale', true]]);
  assert.equal(writes, 0);
  assert.deepEqual(kept.getState().notices, []);
});

test('a local-network migration that cannot be saved still never listens on the old address', async () => {
  const started = [];
  const remote = new RemoteControl({ load: () => ({ version: 1, enabled: true, port: 45123, bindAddress: '192.168.1.20', allowedOrigins: [], tokens: [] }),
    save: () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); }, getService: () => null, ensureStorage() {}, getStorageError: () => null,
    harnesses: { defaultHarness: 't3', describe: () => [], has: () => false, get() { throw new Error('none'); } }, appInfo: { name: 'test', version: '0' }, networkInterfaces: () => ({}),
    createServer: () => { const server = require('node:http').createServer(); const listen = server.listen.bind(server); server.listen = (options, ...rest) => { started.push(options.host); return listen({ ...options, port: 0 }, ...rest); }; return server; } });
  assert.equal(remote.getState().bindAddress, null);
  await remote.start();
  await remote.stop();
  assert.deepEqual(started, ['127.0.0.1']);
});
