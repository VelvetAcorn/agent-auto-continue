'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createCodexHarness } = require('../lib/harnesses/codex');
const { answerServerRequest } = require('../lib/harnesses/codex-rpc');
const { createReader, daemonAvailable, isDesktopThread, limitFromRateLimits, ownerOfThread } = require('../lib/harnesses/codex-reader');
const { codexThreadWriter, parseLsof, readCodexThreadWriters } = require('../lib/harnesses/codex-locks');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { JobService } = require('../lib/job-service');

const THREAD = '01a0f463-49c5-7d82-a1fd-2c4b9fc9a5d0';
const NESTED = '01a0f463-0000-7d82-a1fd-2c4b9fc9a5d1';
const DESKTOP = '01a0f463-1111-7d82-a1fd-2c4b9fc9a5d2';
const T3 = '01a0f463-2222-7d82-a1fd-2c4b9fc9a5d3';
const roots = [];
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function setup({ mode = 'complete', account = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }, rateLimits, status = { type: 'notLoaded' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  for (const dir of [bin, home, project]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-codex'), path.join(bin, 'codex'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const statePath = path.join(root, 'state.json');
  const userTurn = (id, startedAt, clientId = null) => ({ id, status: 'completed', startedAt, completedAt: startedAt + 5, error: null, items: [{ type: 'userMessage', id: `${id}-item`, clientId, content: [{ type: 'text', text: 'hi', text_elements: [] }] }] });
  const thread = (id, extra) => ({ id, name: null, preview: '', cwd: project, updatedAt: 1_790_806_000, status: { type: 'idle' }, ephemeral: false, parentThreadId: null, originator: null, turns: [], ...extra });
  fs.writeFileSync(statePath, JSON.stringify({
    account,
    rateLimits: rateLimits ?? { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_791_407_591 }, secondary: null, rateLimitReachedType: null }, ordinaryUsageAllowed: true },
    threads: {
      [THREAD]: thread(THREAD, { preview: 'Please   update the Ko-fi link', updatedAt: 1_790_806_722, status,
        turns: [userTurn('turn-1', 1_790_806_000), { id: 'turn-2', status: 'completed', startedAt: 1_790_806_100, items: [{ type: 'agentMessage', id: 'x' }] }, userTurn('turn-3', 1_790_806_600)] }),
      [NESTED]: thread(NESTED, { name: 'Subagent', parentThreadId: THREAD }),
      [DESKTOP]: thread(DESKTOP, { name: 'Desktop thread', originator: 'Codex Desktop' }),
      [T3]: thread(T3, { name: 'T3 thread', originator: 't3code_desktop' })
    }
  }));
  const logFile = path.join(root, 'log.jsonl');
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, FAKE_CODEX_STATE: statePath, FAKE_CODEX_LOG: logFile, FAKE_CODEX_MODE: mode, CLAUDECODE: '1', T3_TOKEN: 'secret', OPENAI_API_KEY: 'user-key' };
  const writers = { current: null };
  return {
    root, project, home, env, writers,
    make: (options = {}) => createCodexHarness({ env, home, requestTimeoutMs: 5000, transport: 'private', threadWriter: async (_id, opts) => (typeof writers.current === 'function' ? writers.current(opts) : writers.current), threadWriters: async () => new Map(), ...options }),
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
  };
}
const turn = (patch = {}) => Object.freeze({ jobId: 'job', harness: 'codex', conversationId: THREAD, message: 'Continue', messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', commandId: 'c', deliveryKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ...patch });
async function send(s, adapter = s.make(), id = THREAD) {
  const state = await adapter.inspectConversation({ conversationId: id, deliveryKey: turn().deliveryKey });
  const { plan } = adapter.prepareTurn(turn({ conversationId: id }), state);
  return adapter.submitTurn(turn({ conversationId: id }), plan);
}

test('connection check reports sign-in state and sanitizes the child environment', async () => {
  const s = setup();
  assert.deepEqual(await s.make().checkConnection(), { ok: true });
  const start = s.log().find((entry) => entry.start);
  assert.equal(start.env.includes('CLAUDECODE'), false);
  assert.equal(start.env.includes('T3_TOKEN'), false);
  assert.equal(start.env.includes('OPENAI_API_KEY'), true);
  await assert.rejects(setup({ account: { account: null, requiresOpenaiAuth: true } }).make().checkConnection(), { code: 'missing_credentials' });
  await assert.rejects(s.make({ getSettings: () => ({ executable: '/nonexistent/codex' }) }).checkConnection(), { code: 'harness_not_installed' });
});

test('lists only CLI-owned top-level threads, marking ones another process is writing', async () => {
  const s = setup({ status: { type: 'active', activeFlags: [] } });
  const list = await s.make().listConversations();
  assert.deepEqual(list.map((item) => item.id), [THREAD]);
  assert.equal(list[0].title, 'Please update the Ko-fi link');
  assert.equal(list[0].projectName, 'project');
  assert.equal(list[0].state, 'working');
  assert.equal(list[0].updatedAt, new Date(1_790_806_722_000).toISOString());
  assert.deepEqual(s.log().find((entry) => entry.method === 'thread/list').params, { limit: 100, sortKey: 'updated_at', archived: false });
  const held = await s.make({ threadWriters: async () => new Map([[THREAD, { pid: 42, owner: 'codex-desktop' }]]) }).listConversations();
  assert.equal(held[0].state, 'in-use');
  assert.equal(ownerOfThread({ originator: 'Codex Desktop' }), 'codex-desktop');
  assert.equal(ownerOfThread({ originator: null, source: 'vscode' }), 'codex-desktop', 'Older desktop threads have no originator');
  assert.equal(ownerOfThread({ originator: 't3code_desktop', source: 'vscode' }), 't3');
  assert.equal(ownerOfThread({ originator: null, source: 'cli' }), 'codex');
  assert.equal(ownerOfThread({ originator: 'codex_exec', source: 'exec' }), 'codex');
  assert.equal(isDesktopThread({ originator: 'Codex Desktop', parentThreadId: 'x' }), false, 'Subagent threads are never desktop threads');
  assert.equal(isDesktopThread({ originator: 'Codex Desktop', ephemeral: true }), false);
});

test('inspection reports user activity, stable-key delivery and approval waits', async () => {
  const s = setup({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  const state = await s.make().inspectConversation({ conversationId: THREAD, deliveryKey: 'nothing' });
  assert.equal(state.latestUserActivityAt, new Date(1_790_806_600_000).toISOString());
  assert.equal(state.delivered, false);
  assert.equal(state.awaitingInput, true);
  assert.equal(state.busy, true);
  assert.equal((await setup().make().inspectConversation({ conversationId: THREAD, deliveryKey: null })).awaitingInput, null, 'Unloaded threads are unknown');
  await assert.rejects(s.make().inspectConversation({ conversationId: '01a0f463-ffff-7d82-a1fd-2c4b9fc9a5d0', deliveryKey: null }), { code: 'conversation_not_found' });
  await assert.rejects(s.make().inspectConversation({ conversationId: 'not-a-uuid', deliveryKey: null }), { code: 'conversation_not_found' });
});

test('preparation refuses other harnesses’ threads, busy threads, foreign writers and missing folders', async () => {
  const s = setup();
  const adapter = s.make();
  for (const [id, harness] of [[DESKTOP, 'codex-desktop'], [T3, 't3']]) {
    const state = await adapter.inspectConversation({ conversationId: id, deliveryKey: null });
    assert.throws(() => adapter.prepareTurn(turn({ conversationId: id }), state), (error) => error.code === 'owned_by_other_harness' && error.details.harness === harness && !error.deliveryUncertain);
  }
  const state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: null });
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, writer: { pid: 7, owner: 'codex-desktop' } } }), /open in the Codex desktop app/);
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, writer: { pid: 7, owner: 'other' } } }), { code: 'conversation_busy' });
  assert.doesNotThrow(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, writer: { pid: 7, owner: 'daemon' } } }));
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, inProgress: true } }), { code: 'conversation_busy' });
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, cwd: path.join(s.home, 'gone') } }), { code: 'conversation_not_found' });
});

test('submission resumes the thread with a client message ID and reports completion', async () => {
  const s = setup();
  const adapter = s.make();
  const result = await send(s, adapter);
  assert.equal(result.turnId, 'turn-4');
  assert.equal((await result.completion).state, 'completed');
  const start = s.log().find((entry) => entry.method === 'turn/start');
  assert.equal(start.params.clientUserMessageId, turn().deliveryKey);
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'Continue', text_elements: [] }]);
  assert.equal(fs.realpathSync(s.log().filter((entry) => entry.start).at(-1).cwd), fs.realpathSync(s.project));
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  assert.equal((await s.make().checkTurn(turn())).state, 'completed', 'A new process reads the outcome back');
  assert.equal((await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey })).delivered, true);
});

test('approval and input requests stop the unattended turn and report approval_required', async () => {
  const approval = setup({ mode: 'approval' });
  const outcome = await (await send(approval)).completion;
  assert.equal(outcome.state, 'interrupted');
  assert.equal(outcome.error.code, 'approval_required');
  assert.deepEqual(approval.state().decisions, [{ decision: 'cancel' }]);
  const input = setup({ mode: 'user-input' });
  const asked = await (await send(input)).completion;
  assert.equal(asked.state, 'interrupted');
  assert.equal(asked.error.code, 'approval_required');
  assert.ok(input.log().some((entry) => entry.method === 'turn/interrupt'));
});

test('a usage-limit failure carries the account reset time', async () => {
  const s = setup({ mode: 'limit', rateLimits: { rateLimits: { primary: { usedPercent: 100, resetsAt: 4_102_444_800 }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } });
  const outcome = await (await send(s)).completion;
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'usage_limited');
  assert.equal(outcome.usageLimit.resetsAt, '2100-01-01T00:00:00.000Z');
});

test('writer locks are re-checked after resume, and Codex’s own writer lock is respected', async () => {
  const s = setup();
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: null });
  const { plan } = adapter.prepareTurn(turn(), state);
  s.writers.current = { pid: 4242, owner: 'codex-desktop' };
  await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
  assert.equal(s.log().some((entry) => entry.method === 'turn/start'), false);
  s.writers.current = (opts) => ({ pid: opts.selfPids[0], owner: 'self' });
  assert.equal((await (await adapter.submitTurn(turn(), plan)).completion).state, 'completed');
  await assert.rejects(send(setup({ mode: 'locked' })), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
});

test('rejections are certain, a crash after turn/start is uncertain', async () => {
  await assert.rejects(send(setup({ mode: 'reject' })), (error) => error.deliveryUncertain === false);
  await assert.rejects(send(setup({ mode: 'crash' })), (error) => error.deliveryUncertain === true && error.code === 'process_failed');
});

test('a private-server turn is interrupted on shutdown and unknown after a restart', async () => {
  const s = setup({ mode: 'long' });
  const adapter = s.make();
  const result = await send(s, adapter);
  assert.equal((await adapter.checkTurn(turn())).state, 'running');
  assert.throws(() => adapter.prepareTurn(turn(), { context: { cwd: s.project, owner: 'codex' } }), { code: 'conversation_busy' });
  const restarted = s.make();
  assert.equal((await restarted.checkTurn(turn())).state, 'unknown');
  await adapter.shutdown();
  assert.equal((await result.completion).state, 'interrupted');
});

test('the shared daemon is used through the proxy with WebSocket framing when it is running', async () => {
  const s = setup({ mode: 'long' });
  const adapter = s.make({ transport: 'auto', detectDaemon: async () => true });
  assert.equal((await adapter.listConversations()).length, 1);
  const result = await send(s, adapter);
  assert.equal(result.turnId, 'turn-4');
  const calls = s.log().filter((entry) => entry.method);
  assert.ok(calls.every((entry) => entry.proxy), 'Every request went through the proxy');
  assert.ok(s.log().some((entry) => entry.pong), 'Pings are answered');
  assert.equal((await adapter.checkTurn(turn())).state, 'running');
  await adapter.shutdown();
  assert.equal(s.log().some((entry) => entry.method === 'turn/interrupt'), false, 'Daemon turns are not interrupted on shutdown');
  const later = s.make({ transport: 'auto', detectDaemon: async () => true });
  assert.equal((await later.checkTurn(turn())).state, 'running', 'The daemon still owns the turn');
  const refused = setup({ mode: 'bad-handshake' });
  await assert.rejects(refused.make({ transport: 'auto', detectDaemon: async () => true }).checkConnection(), /daemon/);
  assert.equal(refused.log().filter((entry) => entry.start).every((entry) => entry.proxy), true, 'No fallback to a private server');
  void result.completion;
});

test('availability comes from the account rate-limit snapshot', async () => {
  const available = await setup().make().probeAvailability();
  assert.equal(available.state, 'available');
  assert.equal(available.source, 'reported');
  const limited = await setup({ rateLimits: { rateLimits: { primary: { usedPercent: 100, resetsAt: 4_102_444_800 }, secondary: { usedPercent: 20, resetsAt: 4_102_000_000 }, rateLimitReachedType: null } } }).make().probeAvailability();
  assert.equal(limited.state, 'limited');
  assert.equal(limited.resetsAt, '2100-01-01T00:00:00.000Z');
  assert.equal((await setup({ rateLimits: { rateLimits: null } }).make().probeAvailability()).state, 'unknown');
  assert.equal(limitFromRateLimits({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 10, resetsAt: 4_102_444_800 } } }, Date.now()).reached, true);
});

test('server requests that need a person are answered with the variant that stops the turn', () => {
  assert.deepEqual(answerServerRequest('item/commandExecution/requestApproval'), { decision: 'cancel' });
  assert.deepEqual(answerServerRequest('item/fileChange/requestApproval'), { decision: 'cancel' });
  assert.deepEqual(answerServerRequest('execCommandApproval'), { decision: 'abort' });
  assert.deepEqual(answerServerRequest('applyPatchApproval'), { decision: 'abort' });
  assert.deepEqual(answerServerRequest('mcpServer/elicitation/request'), { action: 'cancel', content: null });
  assert.equal(answerServerRequest('account/chatgptAuthTokens/refresh'), undefined);
});

test('the shared reader works with an injected executable', async () => {
  const s = setup();
  const reader = createReader({ executable: path.join(s.root, 'bin', 'codex'), env: s.env, home: s.home, transport: 'private' });
  assert.equal((await reader.listThreads()).length, 4);
  assert.equal((await reader.readThread(THREAD)).id, THREAD);
  const turns = await reader.recentTurns(THREAD, 2);
  assert.equal(turns[0].id, 'turn-3');
  assert.equal(reader.turnOutcome(turns[0]).state, 'completed');
  assert.deepEqual(await reader.rateLimits(), { reached: false, resetsAt: null, usedPercent: 40, reason: '' });
  assert.equal(await reader.threadWriter(THREAD), null);
  await reader.close();
});

test('writer-lock helpers parse lsof output and classify holders without a shell', async () => {
  assert.deepEqual(parseLsof('p12\nf5\nn/a/one.lock\np13\nn/a/two.lock\n'), [{ pid: 12, file: '/a/one.lock' }, { pid: 13, file: '/a/two.lock' }]);
  const s = setup();
  const locks = path.join(s.home, '.codex', 'thread-writer-locks');
  fs.mkdirSync(locks, { recursive: true });
  fs.mkdirSync(path.join(s.home, '.codex', 'app-server-daemon'), { recursive: true });
  fs.writeFileSync(path.join(s.home, '.codex', 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: 20 }));
  for (const id of [THREAD, DESKTOP, T3]) fs.writeFileSync(path.join(locks, `${id}.lock`), '');
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === '/usr/sbin/lsof') return { ok: true, stdout: `p10\nn${path.join(locks, `${THREAD}.lock`)}\np20\nn${path.join(locks, `${DESKTOP}.lock`)}\np30\nn${path.join(locks, `${T3}.lock`)}\n` };
    return { ok: true, stdout: args.at(-1) === '10' ? '/Applications/ChatGPT.app/Contents/Resources/codex\n' : '/usr/local/bin/codex\n' };
  };
  const writers = await readCodexThreadWriters({ home: s.home, env: {}, run });
  assert.deepEqual(writers.get(THREAD), { pid: 10, owner: 'codex-desktop' });
  assert.deepEqual(writers.get(DESKTOP), { pid: 20, owner: 'daemon' });
  assert.deepEqual(writers.get(T3), { pid: 30, owner: 'other' });
  assert.deepEqual(await codexThreadWriter(T3, { home: s.home, env: {}, run, selfPids: [30] }), { pid: 30, owner: 'self' });
  assert.equal(await codexThreadWriter(NESTED, { home: s.home, env: {}, run }), null, 'No lock file means no writer');
  assert.equal(await codexThreadWriter(THREAD, { home: s.home, env: {}, run: async () => ({ ok: false, stdout: '' }) }), undefined, 'Unknown when lsof fails');
  assert.ok(calls.every(([file]) => file.startsWith('/')), 'Absolute executables only');
});

test('daemon detection connects to the control socket', async () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'cx-'));
  roots.push(dir);
  const socket = path.join(dir, 's.sock');
  assert.equal(await daemonAvailable(socket), false);
  const server = net.createServer((connection) => connection.end()).listen(socket);
  await new Promise((resolve) => server.once('listening', resolve));
  assert.equal(await daemonAvailable(socket), true);
  server.close();
});

test('a Codex job goes from schedule to delivered and completed through the job service', async () => {
  const s = setup();
  let clock = Date.now() + 60_000;
  const service = new JobService({ harnesses: createHarnessRegistry([s.make()]), now: () => clock, persist: () => {}, scheduleTimer: () => ({ cancel() {} }) });
  const job = await service.create({ harness: 'codex', threadId: THREAD, message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC' });
  assert.equal(job.threadTitle, 'Please update the Ko-fi link');
  assert.equal(job.baselineUserTurnAt, new Date(1_790_806_600_000).toISOString());
  clock += 120_000;
  await service.run(job.id);
  assert.equal(service.get(job.id).status, 'sent');
  assert.equal(service.get(job.id).turn.turnId, 'turn-4');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(service.get(job.id).turn.state, 'completed');
  const owned = await service.create({ harness: 'codex', threadId: DESKTOP, message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC' });
  clock += 120_000;
  await service.run(owned.id);
  assert.equal(service.get(owned.id).status, 'failed');
  assert.equal(service.get(owned.id).error.code, 'owned_by_other_harness');
  assert.equal(service.get(owned.id).deliveryCertainty, 'not-delivered');
});

test('concurrent prepared submissions reserve the conversation until completion', async () => {
  const s = setup();
  const adapter = s.make({ transport: 'daemon' });
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  const first = turn();
  const second = turn({ messageId: 'second', deliveryKey: 'second' });
  const a = adapter.prepareTurn(first, state);
  const b = adapter.prepareTurn(second, state);
  const pending = adapter.submitTurn(first, a.plan);
  await assert.rejects(adapter.submitTurn(second, b.plan), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
  await (await pending).completion;
  assert.equal(s.log().filter((entry) => entry.method === 'turn/start').length, 1);
  assert.equal((await (await adapter.submitTurn(second, b.plan)).completion).state, 'completed');
  await adapter.shutdown();
});

test('unsuccessful starts close the client and release reservations while retaining uncertainty', async () => {
  for (const mode of ['hang-start', 'malformed-start', 'crash', 'reject']) {
    const s = setup({ mode });
    const adapter = s.make({ requestTimeoutMs: 2000 });
    const state = await adapter.inspectConversation({ conversationId: THREAD });
    const { plan } = adapter.prepareTurn(turn(), state);
    await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.deliveryUncertain === (mode !== 'reject'));
    const pid = s.log().filter((entry) => entry.start).at(-1).pid;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.notEqual((await adapter.checkTurn(turn())).state, 'running');
    s.env.FAKE_CODEX_MODE = 'complete';
    const saved = s.state();
    for (const item of saved.threads[THREAD].turns) item.status = 'completed';
    fs.writeFileSync(s.env.FAKE_CODEX_STATE, JSON.stringify(saved));
    const next = turn({ deliveryKey: 'next', messageId: 'next' });
    assert.equal((await (await adapter.submitTurn(next, plan)).completion).state, 'completed');
    await adapter.shutdown();
  }
});

test('the run deadline supervises turn/start before its RPC timeout', async () => {
  const s = setup({ mode: 'hang-start' });
  const adapter = s.make({ requestTimeoutMs: 5000, maxTurnMs: 50 });
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  const { plan } = adapter.prepareTurn(turn(), state);
  const began = Date.now();
  await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.code === 'process_failed' && error.deliveryUncertain);
  assert.ok(Date.now() - began < 4000);
  const pid = s.log().filter((entry) => entry.start).at(-1).pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await adapter.shutdown();
});
