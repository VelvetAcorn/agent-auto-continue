'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessions = require('../lib/harnesses/claude-sessions');

const CLI = '11111111-2222-4333-8444-555555555555';
const DESKTOP_CLI = '66666666-7777-4888-9999-000000000000';
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  roots.push(home);
  const desktop = path.join(home, 'Library', 'Application Support', 'Claude');
  const org = path.join(desktop, 'claude-code-sessions', 'account-1', 'org-1');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(org, 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'), JSON.stringify({ sessionId: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cliSessionId: DESKTOP_CLI.toUpperCase(), cwd: '/repo', originCwd: '/repo', title: 'Desktop task', isArchived: false, createdAt: 1790800000000, lastActivityAt: '1790809000000', secretSetting: 'x' }));
  fs.writeFileSync(path.join(org, 'local_bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'), JSON.stringify({ sessionId: 'local_bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', cliSessionId: 'not-a-uuid' }));
  fs.writeFileSync(path.join(org, 'local_cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'), '{broken');
  fs.writeFileSync(path.join(org, 'unrelated.json'), JSON.stringify({ cliSessionId: CLI }));
  fs.writeFileSync(path.join(desktop, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [
    { t: 1790808160083, org: 'org-1', u: { fh: 1, sd: 0 } }, { t: 1790809060091, org: 'org-1', u: { fh: 100, sd: 12 } }, { t: 1790809000000, org: 'org-2', u: { fh: 3, sd: 4 } }, { t: 'bad', u: {} }, null
  ] }));
  const registry = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, '100.json'), JSON.stringify({ pid: 100, sessionId: DESKTOP_CLI, status: 'blocked', waitingFor: 'permission', entrypoint: 'claude-desktop', hostSessionId: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', statusUpdatedAt: 1790809000000 }));
  fs.writeFileSync(path.join(registry, '200.json'), JSON.stringify({ pid: 200, sessionId: CLI, status: 'busy', entrypoint: 'cli' }));
  fs.writeFileSync(path.join(registry, '300.json'), JSON.stringify({ pid: 300, sessionId: CLI, status: 'idle' }));
  fs.writeFileSync(path.join(registry, 'notes.json'), JSON.stringify({ pid: 400, sessionId: CLI }));
  const project = path.join(home, '.claude', 'projects', '-repo');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${CLI}.jsonl`);
  const lines = [
    { type: 'user', uuid: 'p1', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'First prompt' } },
    { type: 'user', uuid: 'tr', timestamp: '2026-10-01T10:01:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', uuid: 'meta', isMeta: true, timestamp: '2026-10-01T10:01:00Z', message: { role: 'user', content: 'meta' } },
    { type: 'user', uuid: 'syn', isSynthetic: true, timestamp: '2026-10-01T10:01:00Z', message: { role: 'user', content: 'synthetic' } },
    { type: 'user', uuid: 'p2', timestamp: '2026-10-01T10:02:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Second' }, { type: 'text', text: 'prompt' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:03:00Z', isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 11am (UTC)" }] } }
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n{partial');
  return { home, file, options: { home, env: {}, isAlive: (pid) => pid !== 300 } };
}

test('Claude Desktop sessions are read defensively and own their CLI session IDs', async () => {
  const { options } = fixture();
  const desktop = await sessions.readDesktopCodeSessions(options);
  assert.deepEqual(desktop, [{ sessionId: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cliSessionId: DESKTOP_CLI, cwd: '/repo', originCwd: '/repo', title: 'Desktop task', archived: false, createdAt: new Date(1790800000000).toISOString(), lastActivityAt: new Date(1790809000000).toISOString() }]);
  assert.deepEqual([...await sessions.desktopOwnedCliSessionIds(options)], [DESKTOP_CLI]);
  assert.deepEqual(await sessions.readDesktopCodeSessions({ home: '/nonexistent', env: {} }), []);
});

test('the session store reports files that no longer parse, and calls a missing store empty', async () => {
  const { options } = fixture();
  const store = await sessions.readDesktopCodeSessionStore(options);
  assert.deepEqual([store.found, store.files, store.sessions.length, store.unrecognised], [true, 3, 1, 2]);
  assert.match(store.drift, /^2 of 3 session files lack the expected fields \(most often .+, in 1\)\.$/, 'A clear majority of unreadable files is a change');
  assert.deepEqual(await sessions.readDesktopCodeSessionStore({ home: '/nonexistent', env: {} }), { found: false, files: 0, sessions: [], unrecognised: 0, drift: '' });
});

test('the live registry returns only live processes with normalised status', async () => {
  const { options } = fixture();
  const desktop = await sessions.readLiveSession(DESKTOP_CLI.toUpperCase(), options);
  assert.equal(desktop.status, 'blocked');
  assert.equal(desktop.entrypoint, 'claude-desktop');
  assert.equal(desktop.hostSessionId, 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(desktop.updatedAt, new Date(1790809000000).toISOString());
  assert.equal((await sessions.readLiveSession(CLI, options)).pid, 200, 'The dead pid 300 entry is ignored');
  assert.equal(await sessions.readLiveSession(CLI, { ...options, isAlive: () => false }), null);
});

test('the live registry classifies every live entry and names what changed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-registry-'));
  roots.push(home);
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.parse('2026-10-01T12:00:00Z');
  const id = (n) => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;
  const write = (pid, value) => fs.writeFileSync(path.join(dir, `${pid}.json`), typeof value === 'string' ? value : JSON.stringify({ pid, startedAt: now - 600_000, kind: 'interactive', entrypoint: 'cli', ...value }));
  write(1, { sessionId: id(1), status: 'shell' });
  write(2, { sessionId: id(2), status: 'running' });
  write(3, { sessionId: id(3) });
  write(4, { sessionId: id(4), startedAt: now - 2_000 });
  write(5, { session: id(5), status: 'busy' });
  write(6, '{"pid": 6, "sessionId": "');
  write(7, { sessionId: id(7), status: 'idle' });
  fs.writeFileSync(path.join(dir, '7.abcdef.key'), 'not a registry entry');
  const registry = await sessions.readLiveRegistry({ home, env: {}, now: () => now, isAlive: (pid) => pid !== 7 });
  assert.equal(registry.found, true);
  const states = Object.fromEntries([...registry.sessions].map(([key, entry]) => [key.slice(0, 8), [entry.state, entry.drift]]));
  assert.deepEqual(states, {
    '00000001': ['busy', ''],
    '00000002': ['unrecognised', 'The live registry entry 2.json reports the unknown status "running".'],
    '00000003': ['unrecognised', 'The live registry entry 3.json reports no status.'],
    '00000004': ['starting', '']
  }, 'A half-written file is skipped, as Claude Code does, and dead processes are ignored');
  assert.deepEqual(registry.unidentified, [{ pid: 5, hint: 'The live registry entry 5.json of a running process has no session ID (sessionId: missing).' }]);
  assert.deepEqual(registry.pids, [1, 2, 3, 4, 5]);
  assert.deepEqual(await sessions.readLiveRegistry({ home: '/nonexistent', env: {} }), { found: false, pids: [], sessions: new Map(), unidentified: [] });
});

test('plan usage returns the newest valid sample, optionally for one organisation', async () => {
  const { options } = fixture();
  assert.deepEqual(await sessions.readClaudePlanUsage(options), { sampledAt: new Date(1790809060091).toISOString(), org: 'org-1', fiveHourPct: 100, sevenDayPct: 12 });
  assert.equal((await sessions.readClaudePlanUsage({ ...options, org: 'org-2' })).fiveHourPct, 3);
  assert.equal(await sessions.readClaudePlanUsage({ home: '/nonexistent', env: {} }), null);
});

test('transcripts yield human prompts and the outcome after a prompt', async () => {
  const { file, options } = fixture();
  assert.equal(await sessions.findTranscriptPath(CLI.toUpperCase(), options), file);
  assert.equal(await sessions.findTranscriptPath('../x', options), null);
  assert.deepEqual(await sessions.readHumanPrompts(file), [
    { uuid: 'p1', timestamp: '2026-10-01T10:00:00.000Z', text: 'First prompt' },
    { uuid: 'p2', timestamp: '2026-10-01T10:02:00.000Z', text: 'Second\nprompt' }
  ]);
  const limited = await sessions.turnOutcomeAfter(file, 'p2');
  assert.equal(limited.state, 'failed');
  assert.equal(limited.usageLimit.resetsAt, '2026-10-01T11:00:00.000Z');
  assert.equal((await sessions.turnOutcomeAfter(file, 'p1')).state, 'completed', 'A later prompt ends the earlier turn');
  assert.equal((await sessions.turnOutcomeAfter(file, 'missing')).state, 'unknown');
  const env = { CLAUDE_CONFIG_DIR: path.join(options.home, '.claude') };
  assert.equal(sessions.claudePaths({ home: '/elsewhere', env }).projectsDir, path.join(options.home, '.claude', 'projects'));
});

test('an interruption marker ends the turn as interrupted and is not user activity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-interrupt-'));
  roots.push(dir);
  const file = path.join(dir, 'session.jsonl');
  const at = (s) => new Date(Date.UTC(2026, 8, 30, 12, 0, s)).toISOString();
  const rows = [
    { type: 'user', uuid: 'job-key', timestamp: at(0), isSidechain: false, cwd: dir, message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] } },
    { type: 'assistant', uuid: 'a1', timestamp: at(5), isSidechain: false, cwd: dir, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } },
    // Shape recorded by Claude Code 2.1.278 when the user presses Esc: a plain user text record.
    { type: 'user', uuid: 'i1', timestamp: at(9), isSidechain: false, cwd: dir, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const scan = await sessions.scanTranscript(file, 'job-key');
  assert.deepEqual(sessions.outcomeFromScan(scan, { running: false }), { state: 'interrupted', completedAt: at(9) });
  assert.equal(scan.latestUserActivityAt, null, 'The marker is not a typed prompt');
  assert.deepEqual((await sessions.readHumanPrompts(file)).map((prompt) => prompt.uuid), ['job-key']);
  assert.equal(sessions.isHumanPrompt({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } }), false);
});

