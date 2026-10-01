'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeCodeHarness } = require('../lib/harnesses/claude-code');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { JobService } = require('../lib/job-service');

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-9999-000000000000';

const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function setup({ mode = 'complete', transcripts, live = [], extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  const store = path.join(home, '.claude', 'projects', '-encoded-project');
  for (const dir of [bin, project, store, path.join(home, '.claude', 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude'), path.join(bin, 'claude'));
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const at = (minutes) => new Date(Date.UTC(2026, 8, 30, 12, minutes)).toISOString();
  const rows = transcripts ?? {
    [SESSION]: [
      { type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: SESSION },
      { type: 'user', uuid: 'u1', cwd: project, timestamp: at(0), message: { role: 'user', content: 'Refactor the scheduler please' } },
      { type: 'assistant', uuid: 'a1', cwd: project, timestamp: at(1), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Working' }] } },
      { type: 'user', uuid: 't1', cwd: project, timestamp: at(9), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', uuid: 'm1', cwd: project, timestamp: at(9), isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'user', uuid: 's1', cwd: project, timestamp: at(9), isSidechain: true, message: { role: 'user', content: 'subagent' } },
      'not json at all',
      { type: 'ai-title', aiTitle: 'Scheduler refactor', sessionId: SESSION },
      { type: 'user', uuid: 'u2', cwd: project, timestamp: at(5), message: { role: 'user', content: [{ type: 'text', text: 'Keep going' }] } }
    ],
    [OTHER]: [
      { type: 'user', uuid: 'o1', cwd: project, timestamp: at(20), message: { role: 'user', content: 'Other task' } },
      { type: 'custom-title', customTitle: 'Renamed by user', sessionId: OTHER },
      { type: 'ai-title', aiTitle: 'Ignored ai title', sessionId: OTHER }
    ],
    '99999999-9999-4999-8999-999999999999': [{ type: 'file-history-snapshot', snapshot: {} }]
  };
  for (const [id, records] of Object.entries(rows)) fs.writeFileSync(path.join(store, `${id}.jsonl`), records.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n');
  fs.mkdirSync(path.join(store, SESSION, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(store, SESSION, 'subagents', 'agent-1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'nested' } }) + '\n');
  for (const [index, entry] of live.entries()) fs.writeFileSync(path.join(home, '.claude', 'sessions', `${1000 + index}.json`), JSON.stringify({ pid: 1000 + index, ...entry }));
  const logFile = path.join(root, 'log.jsonl');
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: logFile, FAKE_TRANSCRIPT: path.join(store, `${SESSION}.jsonl`), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', T3_TOKEN: 'secret-token', ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ...extraEnv };
  const alive = new Set(live.map((_entry, index) => 1000 + index));
  const make = (options = {}) => createClaudeCodeHarness({ env, home, isAlive: (pid) => alive.has(pid), ackTimeoutMs: 2000, ...options });
  return { root, home, project, store, env, make, alive, log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []), at };
}
const turn = (patch = {}) => Object.freeze({ jobId: 'job', harness: 'claude-code', conversationId: SESSION, message: 'Continue', messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', commandId: 'c', deliveryKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ...patch });

test('lists conversational sessions with the best available title, newest first, ignoring subagents', async () => {
  const s = setup({ live: [{ sessionId: OTHER, status: 'waiting', name: 'live name' }] });
  const list = await s.make().listConversations();
  assert.deepEqual(list.map((item) => item.id), [OTHER, SESSION]);
  assert.equal(list[0].title, 'Renamed by user');
  assert.equal(list[0].state, 'waiting');
  assert.equal(list[1].title, 'Scheduler refactor');
  assert.equal(list[1].state, 'idle');
  assert.equal(list[1].projectName, 'project');
  assert.equal(list[1].projectId, s.project);
  assert.equal(list[1].settled, false);
});

test('falls back to the first typed prompt and survives a missing store', async () => {
  const s = setup({ transcripts: { [SESSION]: [{ type: 'user', cwd: '/tmp', timestamp: '2026-09-30T00:00:00Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } }, { type: 'user', cwd: '/tmp', timestamp: '2026-09-30T00:01:00Z', message: { role: 'user', content: 'Fix   the login\nbug' } }] } });
  assert.equal((await s.make().listConversations())[0].title, 'Fix the login bug');
  fs.rmSync(path.join(s.home, '.claude'), { recursive: true });
  assert.deepEqual(await s.make().listConversations(), []);
});

test('inspection counts only typed user messages and reports delivery, permission mode and live state', async () => {
  const s = setup({ live: [{ sessionId: SESSION, status: 'waiting' }] });
  const state = await s.make().inspectConversation({ conversationId: SESSION, deliveryKey: 'u1' });
  assert.equal(state.latestUserActivityAt, s.at(5));
  assert.equal(state.delivered, true);
  assert.equal(state.awaitingInput, true);
  assert.equal(state.context.permissionMode, 'acceptEdits');
  assert.equal(state.context.cwd, s.project);
  assert.equal(state.archived, false);
  const quiet = await setup().make().inspectConversation({ conversationId: SESSION, deliveryKey: 'missing' });
  assert.equal(quiet.delivered, false);
  assert.equal(quiet.awaitingInput, null, 'Without a live process the signal is unknown');
  await assert.rejects(s.make().inspectConversation({ conversationId: '../../etc/passwd', deliveryKey: null }), { code: 'conversation_not_found' });
  await assert.rejects(s.make().inspectConversation({ conversationId: 'abcdefab-abcd-4abc-8abc-abcdefabcdef', deliveryKey: null }), { code: 'conversation_not_found' });
});

test('preparation refuses sessions open elsewhere or without their project folder and maps permission modes', async () => {
  const open = setup({ live: [{ sessionId: SESSION, status: 'idle' }] });
  const adapter = open.make();
  const state = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn(), state), { code: 'conversation_busy' });
  open.alive.clear();
  const closed = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null });
  const { plan, deliveryKey } = adapter.prepareTurn(turn(), closed);
  assert.equal(deliveryKey, turn().messageId);
  assert.deepEqual(plan.args, ['-p', '--resume', SESSION, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-mode', 'acceptEdits']);
  assert.equal(plan.args.includes('Continue'), false, 'The prompt never appears in the process arguments');
  assert.equal(plan.input.uuid, turn().messageId);
  assert.throws(() => adapter.prepareTurn(turn(), { ...closed, context: { ...closed.context, cwd: path.join(open.root, 'gone') } }), { code: 'conversation_not_found' });
  const manual = adapter.prepareTurn(turn(), { ...closed, context: { ...closed.context, permissionMode: 'default' } });
  assert.deepEqual(manual.plan.args.slice(-2), ['--permission-mode', 'manual']);
  const unknown = adapter.prepareTurn(turn(), { ...closed, context: { ...closed.context, permissionMode: 'future-mode' } });
  assert.equal(unknown.plan.args.includes('--permission-mode'), false);
  assert.throws(() => open.make({ getSettings: () => ({ executable: path.join(open.root, 'missing', 'claude') }) }).prepareTurn(turn(), closed), { code: 'harness_not_installed' });
  assert.throws(() => open.make({ getSettings: () => ({ executable: 'claude' }) }).prepareTurn(turn(), closed), { code: 'harness_not_installed' }, 'Overrides must be absolute');
});

test('a live registry entry that names no session refuses, because it could hold this session', async () => {
  // An update renames the session field, so the terminal session holding SESSION can no longer be matched.
  const s = setup({ live: [{ session_id: SESSION, status: 'busy', kind: 'interactive', entrypoint: 'cli' }] });
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'live_registry'
    && error.message === 'Claude Code changed how it reports whether the agent is working, so Agent Auto-Continue could not send. Nothing was sent.' && /no session ID/.test(error.details.hint));
  s.alive.clear();
  const closed = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null });
  assert.doesNotThrow(() => adapter.prepareTurn(turn(), closed), 'Entries of processes that ended do not count');
});

test('a transcript in an unfamiliar format refuses before resuming, because user activity could not be seen', async () => {
  const s = setup();
  // An update records the user's newest prompt under a record type this version does not know.
  fs.appendFileSync(path.join(s.store, `${SESSION}.jsonl`), JSON.stringify({ type: 'human', uuid: 'n1', cwd: s.project, timestamp: s.at(30), message: { role: 'user', content: 'I am back' } }) + '\n');
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'transcript'
    && error.message === 'Claude Code changed how it records conversations, so Agent Auto-Continue cannot work with it until it supports this version.');
});

async function send(s, adapter = s.make()) {
  const state = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: turn().deliveryKey });
  const { plan } = adapter.prepareTurn(turn(), state);
  return adapter.submitTurn(turn(), plan);
}

test('submission resumes over stdin in the session folder with a sanitized environment and confirms by replay', async () => {
  const s = setup();
  const adapter = s.make();
  const result = await send(s, adapter);
  const outcome = await result.completion;
  assert.equal(outcome.state, 'completed');
  const [call] = s.log();
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(s.project));
  assert.equal(call.input.message.content[0].text, 'Continue');
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'T3_TOKEN', 'ELECTRON_RUN_AS_NODE']) assert.equal(call.env.includes(name), false, name);
  assert.equal(call.env.includes('ANTHROPIC_BASE_URL'), true, 'User provider configuration is preserved');
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  assert.equal((await adapter.checkTurn(turn())).state, 'completed');
  const restarted = s.make();
  assert.equal((await restarted.checkTurn(turn())).state, 'completed', 'The transcript answers after a restart');
});

test('a usage limit after delivery is a delivered turn that failed with a reset time', async () => {
  const s = setup({ mode: 'limit' });
  const adapter = s.make({ now: () => Date.parse('2026-10-01T14:00:00Z') });
  const outcome = await (await send(s, adapter)).completion;
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'usage_limited');
  assert.equal(outcome.usageLimit.resetsAt, '2026-10-01T15:00:00.000Z');
  const later = await s.make({ now: () => Date.parse('2026-10-01T14:30:00Z') }).checkTurn(turn());
  assert.equal(later.state, 'failed');
  assert.equal(later.usageLimit.resetsAt, '2026-10-01T15:00:00.000Z');
});

test('failures before the message reaches the transcript are certain non-deliveries', async () => {
  await assert.rejects(send(setup({ mode: 'no-auth' })), (error) => error.code === 'missing_credentials' && error.deliveryUncertain === false);
  await assert.rejects(send(setup({ mode: 'crash' })), (error) => error.code === 'process_failed' && error.deliveryUncertain === false);
});

test('a transcript entry that lands just after exit still counts as delivered', async () => {
  const late = setup({ mode: 'late-write' });
  const result = await send(late, late.make({ flushGraceMs: 2500 }));
  assert.equal((await result.completion).state, 'failed', 'The run itself ended without a result');
  const hasty = setup({ mode: 'late-write' });
  await assert.rejects(send(hasty, hasty.make({ flushGraceMs: 0 })), (error) => error.deliveryUncertain === false, 'Without the grace the early read decides non-delivery');
});

test('a missing acknowledgement defers to the transcript, and a hung process is stopped without delivery', async () => {
  const slow = setup({ mode: 'slow-ack' });
  const result = await send(slow, slow.make({ ackTimeoutMs: 1000 }));
  assert.equal((await result.completion).state, 'completed');
  const hung = setup({ mode: 'hang' });
  const started = Date.now();
  await assert.rejects(send(hung, hung.make({ ackTimeoutMs: 200 })), (error) => error.code === 'timeout' && error.deliveryUncertain === false);
  assert.ok(Date.now() - started < 8000);
});

test('shutdown interrupts running turns', async () => {
  const s = setup({ mode: 'long' });
  const adapter = s.make();
  const result = await send(s, adapter);
  assert.equal((await adapter.checkTurn(turn())).state, 'running');
  await adapter.shutdown();
  assert.equal((await result.completion).state, 'interrupted');
});

test('availability is inferred from recent usage-limit messages', async () => {
  const now = Date.parse('2026-10-01T14:00:00Z');
  const limit = (at, text) => ({ type: 'assistant', timestamp: at, isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const ok = (at) => ({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'fine' }] } });
  const probe = (records) => setup({ transcripts: { [SESSION]: records } }).make({ now: () => now }).probeAvailability();
  const limited = await probe([ok('2026-10-01T13:00:00Z'), limit('2026-10-01T13:30:00Z', "You've hit your limit · resets 3pm (UTC)")]);
  assert.equal(limited.state, 'limited');
  assert.equal(limited.resetsAt, '2026-10-01T15:00:00.000Z');
  assert.equal(limited.source, 'inferred');
  assert.equal((await probe([limit('2026-10-01T13:30:00Z', 'Claude AI usage limit reached|1790860000'), ok('2026-10-01T13:40:00Z')])).state, 'available');
  assert.equal((await probe([limit('2026-10-01T12:00:00Z', "You've hit your limit · resets 1pm (UTC)")])).state, 'available', 'A past reset is no longer limiting');
  assert.equal((await probe([limit('2026-10-01T01:00:00Z', "You've reached your model limit.")])).state, 'unknown', 'Old limits without a reset are ignored');
  assert.equal((await probe([ok('2026-10-01T13:00:00Z')])).state, 'unknown');
});

test('sessions Claude Desktop wrote are recognised from the transcript too, so a changed Desktop store cannot expose them', async () => {
  const s = setup();
  // Claude Desktop's store is unreadable after an update, but its transcript records name Claude Desktop as the entrypoint.
  const org = path.join(s.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(org, 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'), JSON.stringify({ id: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cli: OTHER }));
  fs.appendFileSync(path.join(s.store, `${OTHER}.jsonl`), JSON.stringify({ type: 'user', uuid: 'o2', entrypoint: 'claude-desktop', cwd: s.project, timestamp: s.at(21), message: { role: 'user', content: 'From the app' } }) + '\n');
  const adapter = s.make();
  assert.deepEqual((await adapter.listConversations()).map((item) => item.id), [SESSION]);
  const state = await adapter.inspectConversation({ conversationId: OTHER, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn({ conversationId: OTHER }), state), (error) => error.code === 'owned_by_other_harness');
  assert.equal(s.log().length, 0, 'Nothing was started');
});

test('sessions owned by Claude Desktop are hidden and refused with a pointer to that harness', async () => {
  const s = setup();
  const org = path.join(s.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(org, 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'), JSON.stringify({ sessionId: 'local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', cliSessionId: OTHER, cwd: s.project, title: 'Desktop', isArchived: false }));
  const adapter = s.make();
  assert.deepEqual((await adapter.listConversations()).map((item) => item.id), [SESSION]);
  const state = await adapter.inspectConversation({ conversationId: OTHER, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn({ conversationId: OTHER }), state), (error) => error.code === 'owned_by_other_harness' && error.details.harness === 'claude-desktop' && !error.deliveryUncertain);
  assert.equal(s.log().length, 0, 'Nothing was started');
});

test('fresh Claude plan usage drives availability; stale samples fall back to transcripts', async () => {
  const s = setup();
  const now = Date.parse('2026-10-01T14:00:00Z');
  const desktop = path.join(s.home, 'Library', 'Application Support', 'Claude');
  fs.mkdirSync(desktop, { recursive: true });
  const write = (t, fh, sd) => fs.writeFileSync(path.join(desktop, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples: [{ t, org: 'o', u: { fh, sd } }] }));
  write(now - 5 * 60_000, 100, 40);
  const limited = await s.make({ now: () => now }).probeAvailability();
  assert.equal(limited.state, 'limited');
  assert.equal(limited.source, 'inferred');
  assert.equal(limited.resetsAt, null);
  assert.match(limited.reason, /five-hour/);
  write(now - 5 * 60_000, 30, 101);
  assert.match((await s.make({ now: () => now }).probeAvailability()).reason, /weekly/);
  write(now - 5 * 60_000, 30, 40);
  assert.equal((await s.make({ now: () => now }).probeAvailability()).state, 'available');
  write(now - 60 * 60_000, 100, 100);
  assert.equal((await s.make({ now: () => now }).probeAvailability()).state, 'unknown', 'A stale sample is ignored');
});

test('a Claude Code job goes from schedule to delivered and completed through the job service', async () => {
  const s = setup();
  let clock = Date.now() + 60_000;
  const timers = [];
  const service = new JobService({ harnesses: createHarnessRegistry([s.make()]), now: () => clock, persist: () => {}, scheduleTimer: (date, callback) => { timers.push(callback); return { cancel() {} }; } });
  const job = await service.create({ harness: 'claude-code', threadId: SESSION, message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC' });
  assert.equal(job.threadTitle, 'Scheduler refactor');
  assert.equal(job.projectName, 'project');
  clock += 120_000;
  await service.run(job.id);
  assert.equal(service.get(job.id).status, 'sent');
  assert.equal(service.get(job.id).deliveryKey, undefined, 'Claude Code uses the job message ID as its key');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.get(job.id).turn.state, 'completed');
  assert.equal(s.log().length, 1);
});

test('concurrent prepared submissions reserve the session until completion', async () => {
  const s = setup();
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  const first = turn();
  const second = turn({ messageId: 'second', deliveryKey: 'second' });
  const a = adapter.prepareTurn(first, state);
  const b = adapter.prepareTurn(second, state);
  const pending = adapter.submitTurn(first, a.plan);
  await assert.rejects(adapter.submitTurn(second, b.plan), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
  await (await pending).completion;
  assert.equal(s.log().length, 1);
  assert.equal((await (await adapter.submitTurn(second, b.plan)).completion).state, 'completed');
});

test('failed starts release the session reservation', async () => {
  const s = setup({ mode: 'no-auth' });
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  const { plan } = adapter.prepareTurn(turn(), state);
  await assert.rejects(adapter.submitTurn(turn(), plan), { code: 'missing_credentials' });
  s.env.FAKE_CLAUDE_MODE = 'complete';
  assert.equal((await (await adapter.submitTurn(turn(), plan)).completion).state, 'completed');
});
