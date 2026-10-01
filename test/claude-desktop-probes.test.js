'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeDesktopHarness, BUNDLE_ID } = require('../lib/harnesses/claude-desktop');
const { elapsedMs, runningClaudeProcesses } = require('../lib/harnesses/claude-desktop-probes');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const SESSION = 'local_7de42224-49eb-4544-a87c-181a7de40229';
const CLI = '660279f3-a100-4809-91a0-dc5991157d17';
const WRITES = ['setComposer', 'submit', 'clearComposer', 'activate', 'openUrl'];

// A home laid out like Claude Desktop 2.16120.0 and Claude Code 2.1.286 write it.
function setup(t, { processes = async () => [], alive = () => true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-probes-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const registry = path.join(home, '.claude', 'sessions');
  const index = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'account', 'org');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, `${SESSION}.json`), JSON.stringify({ sessionId: SESSION, cliSessionId: CLI, cwd: home, title: 'Plan', isArchived: false, createdAt: NOW - 60_000, lastActivityAt: NOW - 1_000 }));
  const live = (pid, value) => {
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(path.join(registry, `${pid}.json`), JSON.stringify({ pid, sessionId: CLI, startedAt: NOW - 600_000, kind: 'interactive', entrypoint: 'claude-desktop', status: 'idle', ...value }));
  };
  // No conversation is shown, so the interface is not inspected.
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { urlSegment: 'epitaxy' } });
  const adapter = createClaudeDesktopHarness({ home, env: {}, isAlive: alive, automation: fake.automation, isLocked: async () => false, platform: 'darwin', now: () => NOW,
    sleep: async () => {}, appPath: null, processes });
  const check = async (depth) => {
    const result = await adapter.checkCompatibility({ depth });
    assert.deepEqual(fake.state.calls.filter((call) => WRITES.includes(call[0])), [], 'A check never changes anything');
    return result;
  };
  const about = (result, point) => ({
    checked: result.checked.includes(point), problems: result.problems.filter((item) => item.contactPoint === point).map((item) => item.hint),
    unchecked: result.unchecked.filter((item) => item.contactPoint === point).map((item) => item.reason)
  });
  return { home, registry, index, live, check, about };
}

test('the live registry passes when its live entries are recognised', async (t) => {
  const s = setup(t, { processes: async () => [{ pid: 4001 }, { pid: 4002 }] });
  s.live(4001, { status: 'busy' });
  s.live(4002, { status: 'shell', entrypoint: 'cli', sessionId: '11111111-2222-4333-8444-555555555555' });
  const result = await s.check('quick');
  assert.deepEqual(s.about(result, 'live_registry'), { checked: true, problems: [], unchecked: [] });
  assert.equal(result.ok, true);
});

test('a live entry with a status, session field or entrypoint this version does not know is a registry change', async (t) => {
  const renamed = setup(t);
  renamed.live(4001, { status: 'running' });
  let result = await renamed.check('quick');
  assert.deepEqual(renamed.about(result, 'live_registry').problems, ['The live registry entry 4001.json reports the unknown status "running".']);
  assert.equal(result.problems[0].message, 'Claude Desktop 1.0 changed how it reports whether the agent is working. Scheduled messages for it may fail until Agent Auto-Continue supports this version.');

  const unnamed = setup(t);
  unnamed.live(4001, { sessionId: undefined, session: CLI });
  unnamed.live(4002, { sessionId: undefined, session: CLI });
  result = await unnamed.check('quick');
  assert.deepEqual(unnamed.about(result, 'live_registry').problems, ['The live registry entry 4001.json of a running process has no session ID (sessionId: missing). 1 other entry is like it.']);

  const anonymous = setup(t);
  anonymous.live(4001, { entrypoint: undefined });
  result = await anonymous.check('quick');
  assert.deepEqual(anonymous.about(result, 'live_registry').problems, ['1 of 1 live registry entry does not say which app started them (no entrypoint).']);
});

test('running Claude Code processes that are missing from the registry mean it moved', async (t) => {
  const moved = setup(t, { processes: async () => [{ pid: 4001 }, { pid: 4002 }] });
  let result = await moved.check('quick');
  assert.deepEqual(moved.about(result, 'live_registry').problems, ['2 Claude Code processes have been running for over a minute, but ~/.claude/sessions does not exist.']);

  const emptied = setup(t, { processes: async () => [{ pid: 4001 }] });
  emptied.live(4999, {});
  result = await emptied.check('quick');
  assert.deepEqual(emptied.about(result, 'live_registry').problems, ['1 Claude Code process has been running for over a minute, but none has an entry in ~/.claude/sessions.']);

  // One registered process proves the location; others may be headless or wrappers.
  const partly = setup(t, { processes: async () => [{ pid: 4001 }, { pid: 4002 }] });
  partly.live(4001, {});
  assert.equal(partly.about(await partly.check('quick'), 'live_registry').checked, true);
});

test('a missing registry with nothing running, or an unreadable process table, is not a problem', async (t) => {
  const idle = setup(t);
  assert.deepEqual(idle.about(await idle.check('quick'), 'live_registry'), { checked: false, problems: [], unchecked: ['not_found'] });
  const blind = setup(t, { processes: async () => null });
  assert.deepEqual(blind.about(await blind.check('quick'), 'live_registry'), { checked: false, problems: [], unchecked: ['not_found'] });
  const failing = setup(t, { processes: async () => { throw new Error('ps failed'); } });
  assert.deepEqual(failing.about(await failing.check('quick'), 'live_registry').problems, []);
});

test('the process table yields old enough interactive Claude Code processes only', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    if (args[0] === '-axo') {
      return { code: 0, stdout: [
        `  101     1    01:05 claude`,
        `  102     1 2-03:04:05 /Users/me/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude`,
        `  103     1    00:20 claude`,
        `  104 ${process.pid} 10:00 claude`,
        `  105     1    10:00 claude.exe`,
        `  106     1    10:00 /usr/bin/python3`,
        `  107     1    10:00 claude`
      ].join('\n') };
    }
    return { code: 1, stdout: ['101 claude --resume x', '102 /Users/me/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude --output-format stream-json', '105 claude.exe -p --resume x', '107 claude --print hi'].join('\n') };
  };
  assert.deepEqual(await runningClaudeProcesses({ run }), [{ pid: 101 }, { pid: 102 }]);
  assert.deepEqual(calls[1][1], ['-o', 'pid=,args=', '-p', '101,102,105,107']);
  assert.equal(await runningClaudeProcesses({ run: async () => ({ code: null, error: new Error('ENOENT'), stdout: '' }) }), null);
  assert.deepEqual([elapsedMs('01:05'), elapsedMs('1-00:00:00'), elapsedMs('02:00:00'), elapsedMs('bad')], [65_000, 86_400_000, 7_200_000, 0]);
});
