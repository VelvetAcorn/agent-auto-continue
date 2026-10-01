'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { createCodexHarness } = require('../lib/harnesses/codex');
const { answerServerRequest, startAppServer } = require('../lib/harnesses/codex-rpc');
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
  const thread = (id, extra) => ({ id, name: null, preview: '', cwd: project, updatedAt: 1_790_806_000, status: { type: 'idle' }, ephemeral: false, parentThreadId: null, originator: 'codex_cli_rs', source: 'cli', turns: [], ...extra });
  fs.writeFileSync(statePath, JSON.stringify({
    account,
    rateLimits: rateLimits ?? { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_791_407_591 }, secondary: null, rateLimitReachedType: null }, ordinaryUsageAllowed: true },
    threads: {
      [THREAD]: thread(THREAD, { preview: 'Please   update the Ko-fi link', updatedAt: 1_790_806_722, status,
        turns: [userTurn('turn-1', 1_790_806_000), { id: 'turn-2', status: 'completed', startedAt: 1_790_806_100, items: [{ type: 'agentMessage', id: 'x' }] }, userTurn('turn-3', 1_790_806_600)] }),
      [NESTED]: thread(NESTED, { name: 'Subagent', parentThreadId: THREAD }),
      [DESKTOP]: thread(DESKTOP, { name: 'Desktop thread', originator: 'Codex Desktop', source: 'vscode' }),
      [T3]: thread(T3, { name: 'T3 thread', originator: 't3code_desktop', source: 'vscode' })
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
  assert.deepEqual(s.log().find((entry) => entry.method === 'thread/list').params, { limit: 100, sortKey: 'created_at', archived: false, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] });
  assert.equal(list[0].source, 'cli', 'The source tells automation-created threads apart');
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
  const completed = await result.completion;
  assert.equal(completed.state, 'completed');
  assert.equal(completed.lastAgentMessage, 'All done.', 'turn/completed has no items, so the final answer is read back from the turn list');
  const start = s.log().find((entry) => entry.method === 'turn/start');
  assert.equal(start.params.clientUserMessageId, turn().deliveryKey);
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'Continue', text_elements: [] }]);
  assert.equal(fs.realpathSync(s.log().filter((entry) => entry.start).at(-1).cwd), fs.realpathSync(s.project));
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  const readBack = await s.make().checkTurn(turn());
  assert.deepEqual([readBack.state, readBack.lastAgentMessage], ['completed', 'All done.'], 'A new process reads the outcome and final answer back');
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
  s.writers.current = { pid: 20, owner: 'daemon' };
  assert.equal((await later.checkTurn(turn())).state, 'running', 'The daemon still holds the writer lock, so it owns the turn');
  s.writers.current = null;
  assert.equal((await later.checkTurn(turn())).state, 'unknown', 'No live writer means the in-progress turn ended with its server');
  s.writers.current = () => undefined;
  assert.equal((await later.checkTurn(turn())).state, 'running', 'Without lock information the running daemon is assumed to own it');
  s.writers.current = null;
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

test('coalesced start responses and human requests interrupt with or without a request turn ID', async (t) => {
  for (const transport of ['private', 'daemon']) {
    for (const mode of ['coalesced-input', 'coalesced-input-id', 'coalesced-elicitation', 'coalesced-elicitation-id']) {
      const s = setup({ mode });
      const adapter = s.make({ transport, maxTurnMs: 5000 });
      t.after(() => adapter.shutdown());
      const began = Date.now();
      const result = await send(s, adapter);
      const outcome = await result.completion;
      assert.ok(Date.now() - began < 4000, 'Human requests must interrupt before the run deadline');
      assert.equal(outcome.state, 'interrupted');
      assert.equal(outcome.error.code, 'approval_required');
      const interrupts = s.log().filter((entry) => entry.method === 'turn/interrupt');
      assert.equal(interrupts.length, 1);
      assert.deepEqual(interrupts[0].params, { threadId: THREAD, turnId: result.turnId });
      assert.equal(s.state().threads[THREAD].turns.at(-1).status, 'interrupted');
    }
  }
});

test('a terminal usage limit survives client exit during quota enrichment', async (t) => {
  for (const transport of ['private', 'daemon']) {
    const s = setup({ mode: 'limit-exit', rateLimits: { rateLimits: { primary: { usedPercent: 100, resetsAt: 4_102_444_800 }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } });
    const adapter = s.make({ transport });
    t.after(() => adapter.shutdown());
    const result = await send(s, adapter);
    const outcome = await result.completion;
    assert.equal(outcome.state, 'failed');
    assert.equal(outcome.error.code, 'usage_limited');
    assert.equal(outcome.usageLimit.resetsAt, '2100-01-01T00:00:00.000Z');
    assert.deepEqual(await adapter.checkTurn(turn()), outcome);
    const writer = s.log().filter((entry) => entry.start).find((entry) => fs.realpathSync(entry.cwd) === fs.realpathSync(s.project));
    assert.ok(writer);
    assert.throws(() => process.kill(writer.pid, 0), { code: 'ESRCH' });
  }
});

test('the shared reader lists every thread across pages and reports a listing it could not finish', async () => {
  const s = setup();
  const reader = createReader({ executable: path.join(s.root, 'bin', 'codex'), env: s.env, home: s.home, transport: 'private' });
  const all = await reader.listAllThreads({ pageSize: 1 });
  assert.equal(all.complete, true);
  assert.deepEqual(all.threads.map((thread) => thread.id).sort(), [THREAD, NESTED, DESKTOP, T3].sort(), 'Every page is followed');
  assert.deepEqual(s.log().filter((entry) => entry.method === 'thread/list').map((entry) => entry.params.cursor ?? null), [null, '1', '2', '3']);
  assert.deepEqual(await reader.listAllThreads({ archived: true }), { threads: [], complete: true });
  const capped = await reader.listAllThreads({ pageSize: 1, maxPages: 2 });
  assert.deepEqual([capped.threads.length, capped.complete], [2, false], 'A page budget that runs out is reported as incomplete');
  const endless = setup({ mode: 'endless-list' });
  const looping = createReader({ executable: path.join(endless.root, 'bin', 'codex'), env: endless.env, home: endless.home, transport: 'private' });
  assert.equal((await looping.listAllThreads({ pageSize: 10, maxPages: 3 })).complete, false, 'A cursor that never ends is incomplete');
});

const reviewId = (n) => `01a0f463-${String(n).padStart(4, '0')}-7d82-a1fd-2c4b9fc9a5d0`;
function listingSetup(threads) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-list-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-codex-list'), path.join(bin, 'codex'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  fs.writeFileSync(path.join(root, 'threads.json'), JSON.stringify(threads.map((thread) => ({ preview: '', cwd: root, status: { type: 'notLoaded' }, ephemeral: false, parentThreadId: null, archived: false, ...thread }))));
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: root, FAKE_THREADS: path.join(root, 'threads.json') };
  return createCodexHarness({ env, home: root, transport: 'private', threadWriters: async () => new Map() });
}

test('discovery includes codex exec threads, which the server hides unless every source kind is requested', async () => {
  const adapter = listingSetup([
    { id: reviewId(1), name: 'exec', updatedAt: 1_790_000_001, originator: 'codex_exec', source: 'exec' },
    { id: reviewId(2), name: 'old exec', updatedAt: 1_790_000_002, originator: null, source: 'exec' },
    { id: reviewId(3), name: 'desktop', updatedAt: 1_790_000_003, originator: 'Codex Desktop', source: 'vscode' },
    { id: reviewId(4), name: 't3', updatedAt: 1_790_000_004, originator: 't3code_desktop', source: 'vscode' },
    { id: reviewId(5), name: 'old desktop', updatedAt: 1_790_000_005, originator: null, source: 'vscode' }
  ]);
  const listed = await adapter.listConversations();
  assert.deepEqual(listed.map((item) => item.id).sort(), [reviewId(1), reviewId(2)]);
  assert.deepEqual(listed.map((item) => item.source), ['exec', 'exec']);
});

test('discovery pages past threads owned by other harnesses', async () => {
  const threads = Array.from({ length: 120 }, (_, n) => ({ id: reviewId(n + 10), name: `desktop ${n}`, updatedAt: 1_790_100_000 + n, originator: 'Codex Desktop', source: 'vscode' }));
  threads.push({ id: reviewId(1), name: 'older CLI thread', updatedAt: 1_790_000_000, originator: 'codex_cli_rs', source: 'cli' });
  assert.deepEqual((await listingSetup(threads).listConversations()).map((item) => item.id), [reviewId(1)]);
});

test('an undeterminable writer lock refuses at inspection and again after resume', async () => {
  const s = setup({ mode: 'long' });
  s.writers.current = () => undefined;
  const adapter = s.make();
  const state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
  s.writers.current = (opts) => (opts?.selfPids ? undefined : null);
  const clear = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey });
  const { plan } = adapter.prepareTurn(turn(), clear);
  await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.code === 'conversation_busy' && !error.deliveryUncertain);
  await adapter.shutdown();
  assert.equal(s.log().some((entry) => entry.method === 'turn/start'), false);
});

test('the writer check finds a holder through a symlinked Codex home', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS lsof only');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-symlink-')); // /var/folders is a symlink to /private/var/folders
  roots.push(home);
  const env = { CODEX_HOME: path.join(home, '.codex') };
  const locks = path.join(env.CODEX_HOME, 'thread-writer-locks');
  fs.mkdirSync(locks, { recursive: true });
  const id = reviewId(7);
  const file = path.join(locks, `${id}.lock`);
  fs.writeFileSync(file, '');
  const holder = spawn('/bin/sh', ['-c', 'exec /bin/sleep 30 3<"$0"', file], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await codexThreadWriter(id, { home, env }))?.pid, holder.pid);
  assert.equal((await readCodexThreadWriters({ home, env }))?.get(id)?.pid, holder.pid);
});

async function repliesTo(threadId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-foreign-'));
  roots.push(root);
  const logFile = path.join(root, 'replies.jsonl');
  const client = startAppServer({ file: path.join(__dirname, 'fixtures', 'fake-codex-foreign-request'), transport: 'private', cwd: root, env: { ...process.env, FAKE_LOG: logFile }, threadId });
  await client.initialize();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.close();
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

test('approval requests are answered only for the connection’s own thread and never on read-only connections', async () => {
  assert.deepEqual(await repliesTo(null), [], 'Read-only connections leave requests for their owner');
  assert.deepEqual(await repliesTo('my-thread'), [], 'Another client’s approval is not cancelled');
  assert.equal((await repliesTo('someone-elses-thread'))[0]?.result?.decision, 'cancel', 'The connection running that thread stops its own turn');
});

test('only known Codex CLI originators are claimed by the Codex CLI adapter', () => {
  for (const originator of ['codex_vscode', 'zed', 'something_new']) assert.equal(ownerOfThread({ originator, source: 'appServer' }), 'other', originator);
  assert.equal(ownerOfThread({ originator: 't3code_server', source: 'appServer' }), 't3');
  assert.equal(ownerOfThread({ originator: 'codex_cli_rs', source: 'cli' }), 'codex');
  assert.equal(ownerOfThread({ originator: 'codex_exec', source: 'exec' }), 'codex');
  assert.equal(ownerOfThread({ originator: null, source: 'cli' }), 'codex');
  assert.equal(ownerOfThread({ originator: null, source: 'appServer' }), 'other');
});


test('an unknown turn shape stops busy detection instead of reading as idle, before and at send time', async () => {
  const s = setup();
  const edit = (change) => { const state = s.state(); change(state.threads[THREAD].turns); fs.writeFileSync(s.env.FAKE_CODEX_STATE, JSON.stringify(state)); };
  const original = s.state().threads[THREAD].turns;
  const refusal = (pattern) => (error) => {
    assert.deepEqual([error.code, error.deliveryUncertain, error.details.contactPoint, error.details.codexVersion], ['unsupported_response_shape', false, 'app_server', '0.159.0']);
    assert.match(error.message, /^Codex 0\.159\.0 returned .*, which this version of Agent Auto-Continue does not understand, so it could not tell whether Codex is working\. Nothing was sent\.$/);
    assert.match(error.details.hint, pattern);
    return true;
  };
  const cases = [
    [{ id: 'turn-4', status: 'queued', startedAt: 1_790_806_700, items: [] }, /turn status "queued"/],
    [{ id: 'turn-4', status: 'completed', startedAt: '2026-10-01', items: [] }, /startedAt/],
    [{ id: 'turn-4', status: 'completed', startedAt: 1_790_806_700, items: [{ type: 'userMessage', id: 'u' }] }, /userMessage/]
  ];
  const adapter = s.make();
  for (const [odd, hint] of cases) {
    edit((turns) => { turns.splice(0, turns.length, ...original, odd); });
    await assert.rejects(adapter.inspectConversation({ conversationId: THREAD, deliveryKey: null }), refusal(hint));
  }
  // The turn appears between inspection and sending: the re-check right before turn/start refuses too.
  edit((turns) => { turns.splice(0, turns.length, ...original); });
  const state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey });
  const { plan } = adapter.prepareTurn(turn(), state);
  edit((turns) => { turns.push(cases[0][0]); });
  await assert.rejects(adapter.submitTurn(turn(), plan), refusal(/turn status "queued"/));
  assert.ok(!s.log().some((entry) => entry.method === 'turn/start'), 'Nothing was sent');
});

test('the last agent message prefers the final answer, falls back to the newest message, and is null without one', () => {
  const { lastAgentMessage, outcomeFromTurn } = require('../lib/harnesses/codex-reader');
  const item = (text, phase) => ({ type: 'agentMessage', id: String(text), text, phase });
  assert.equal(lastAgentMessage({ items: [item('Thinking', 'commentary'), item('Done. TASK COMPLETE', 'final_answer'), item('PS', 'commentary')] }), 'Done. TASK COMPLETE');
  assert.equal(lastAgentMessage({ items: [item('First', null), item('Second', null)] }), 'Second');
  assert.equal(lastAgentMessage({ items: [{ type: 'userMessage', id: 'u', content: [] }, item('   ', 'final_answer')] }), null);
  assert.equal(lastAgentMessage({}), null);
  assert.equal(outcomeFromTurn({ id: 't', status: 'completed', items: [item('Shipped', 'final_answer')] }).lastAgentMessage, 'Shipped');
  assert.equal(outcomeFromTurn({ id: 't', status: 'inProgress', items: [item('Partial', 'commentary')] }).lastAgentMessage, undefined, 'A running turn has no final message');
  assert.equal(outcomeFromTurn({ id: 't', status: 'failed', error: { message: 'boom' }, items: [item('x', 'final_answer')] }).lastAgentMessage, undefined);
});
