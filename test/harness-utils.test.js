'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { childEnv, findExecutable, runProcess, spawnJsonLines } = require('../lib/harnesses/process');
const { matchUsageLimit, parseResetTime } = require('../lib/harnesses/usage-limits');
const websocket = require('../lib/harnesses/websocket');

test('child environments drop parent-session and credential variables but keep user configuration', () => {
  const env = childEnv({ PATH: '/usr/bin', HOME: '/Users/me', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_ENTRYPOINT: 'cli', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', T3_TOKEN: 't', OPENCODE_SERVER_PASSWORD: 'p', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_HOME: '/x', HTTPS_PROXY: 'http://proxy' }, { executable: '/opt/tools/bin/claude', home: '/Users/me' });
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'T3_TOKEN', 'OPENCODE_SERVER_PASSWORD']) assert.equal(env[name], undefined, name);
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CODEX_HOME', 'HTTPS_PROXY', 'HOME']) assert.ok(env[name], name);
  assert.equal(env.PATH.split(':')[0], '/opt/tools/bin', 'The executable’s own directory comes first');
  assert.ok(env.PATH.includes('/Users/me/.local/bin'));
});

test('executables resolve to absolute paths only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exe-'));
  const file = path.join(dir, 'tool');
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, '');
  assert.equal(findExecutable('tool', { home: '/nonexistent', env: { PATH: dir } }), file);
  assert.equal(findExecutable('plain', { home: '/nonexistent', env: { PATH: dir } }), null, 'Non-executable files are skipped');
  assert.equal(findExecutable('../tool', { home: '/nonexistent', env: { PATH: dir } }), null);
  assert.equal(findExecutable('tool', { home: '/nonexistent', env: {}, override: file }), file);
  assert.equal(findExecutable('tool', { home: '/nonexistent', env: {}, override: 'tool' }), null);
  fs.rmSync(dir, { recursive: true });
});

test('processes run without a shell, time out and report spawn failures', async () => {
  const echoed = await runProcess('/bin/echo', ['$HOME; rm -rf /']);
  assert.equal(echoed.stdout, '$HOME; rm -rf /\n', 'Arguments are never shell-interpreted');
  const slow = await runProcess('/bin/sleep', ['5'], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  const missing = await runProcess('/nonexistent/tool', []);
  assert.equal(missing.error.code, 'ENOENT');
  const capped = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxOutputBytes: 100 });
  assert.equal(capped.stdout.length, 100);
});

test('JSON-lines processes deliver parsed messages and ignore noise', async () => {
  const messages = [];
  const handle = spawnJsonLines(process.execPath, ['-e', 'process.stdin.on("data",d=>{process.stdout.write("noise\\n"+JSON.stringify({echo:String(d).trim()})+"\\n[1]\\n");process.exit(0)})'], { onMessage: (message) => messages.push(message) });
  handle.write({ hello: 1 });
  handle.end();
  assert.equal((await handle.exited).code, 0);
  assert.deepEqual(messages, [{ echo: '{"hello":1}' }]);
});

test('usage-limit wording is recognised and reset times are parsed in many formats', () => {
  const now = Date.parse('2026-10-01T14:30:00Z');
  const cases = [
    ['Claude AI usage limit reached|1790870400', '2026-10-01T16:00:00.000Z'],
    ['5-hour limit reached ∙ resets 3pm', '2026-10-01T15:00:00.000Z'],
    ["You've hit your limit · resets 3pm (Europe/London)", '2026-10-02T14:00:00.000Z'],
    ['Your limit will reset at 9am (America/New_York).', '2026-10-02T13:00:00.000Z'],
    ["You've hit your usage limit. Try again at 3:45 PM.", '2026-10-01T15:45:00.000Z'],
    ['Usage limit reached. Try again in 2 days 3 hours.', '2026-10-03T17:30:00.000Z'],
    ['Rate limit exceeded, resets 2026-10-05T08:00:00Z', '2026-10-05T08:00:00.000Z'],
    ["You've reached your Fable limit. Switch to another model.", null]
  ];
  for (const [text, expected] of cases) {
    assert.ok(matchUsageLimit(text, now, 'UTC'), text);
    assert.equal(parseResetTime(text, now, 'UTC'), expected, text);
  }
  assert.equal(matchUsageLimit('All tests passed', now), null);
  assert.equal(parseResetTime('resets 25pm', now, 'UTC'), null);
  assert.equal(parseResetTime('resets 3 (UTC)', now, 'UTC'), null, 'A bare number is not a time');
  assert.equal(parseResetTime('resets 3pm (Not/AZone)', now, 'UTC'), '2026-10-01T15:00:00.000Z', 'Unknown zones fall back');
});

test('the WebSocket codec performs the handshake and handles fragments, pings and large frames', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  assert.equal(websocket.expectedAccept(key), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.match(websocket.handshakeRequest(key).text, /^GET \/ HTTP\/1\.1\r\n[\s\S]*Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n$/);
  const decoder = websocket.createDecoder(key);
  const handshake = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n');
  const frames = Buffer.concat([handshake, Buffer.from([0x01, 3]), Buffer.from('{"a'), Buffer.from([0x89, 0]), Buffer.from([0x80, 4]), Buffer.from('":1}'), Buffer.from([0x88, 0])]);
  const events = [];
  for (let index = 0; index < frames.length; index += 5) events.push(...decoder.push(frames.subarray(index, index + 5)));
  assert.deepEqual(events.map((event) => event.type), ['handshake', 'ping', 'message', 'close']);
  assert.equal(events[2].text, '{"a":1}');
  const bad = websocket.createDecoder(key).push(Buffer.from('HTTP/1.1 101 OK\r\nSec-WebSocket-Accept: wrong\r\n\r\n'));
  assert.deepEqual(bad, [{ type: 'handshake', ok: false, status: 101 }]);
  const big = 'x'.repeat(70_000);
  const encoded = websocket.encodeFrame(websocket.OPCODES.text, big, Buffer.from([1, 2, 3, 4]));
  assert.equal(encoded[1], 0x80 | 127, 'Client frames are masked and use 64-bit lengths when needed');
  const loop = websocket.createDecoder('k');
  loop.push(Buffer.from(`HTTP/1.1 101 OK\r\nSec-WebSocket-Accept: ${websocket.expectedAccept('k')}\r\n\r\n`));
  assert.equal(loop.push(encoded)[0].text.length, 70_000, 'Masked frames decode too');
  assert.equal(websocket.encodeFrame(1, 'x'.repeat(200))[1], 0x80 | 126);
});
