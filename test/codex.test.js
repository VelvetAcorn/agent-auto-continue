'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexHarness, limitFromRateLimits } = require('../lib/harnesses/codex');
const { declineServerRequest } = require('../lib/harnesses/codex-rpc');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { JobService } = require('../lib/job-service');

const THREAD = '01a0f463-49c5-7d82-a1fd-2c4b9fc9a5d0';
const NESTED = '01a0f463-0000-7d82-a1fd-2c4b9fc9a5d1';
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
  fs.writeFileSync(statePath, JSON.stringify({
    account,
    rateLimits: rateLimits ?? { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_791_407_591 }, secondary: null, rateLimitReachedType: null }, ordinaryUsageAllowed: true },
    threads: {
      [THREAD]: { id: THREAD, name: null, preview: 'Please   update the Ko-fi link', cwd: project, updatedAt: 1_790_806_722, status, ephemeral: false, parentThreadId: null,
        turns: [userTurn('turn-1', 1_790_806_000), { id: 'turn-2', status: 'completed', startedAt: 1_790_806_100, items: [{ type: 'agentMessage', id: 'x' }] }, userTurn('turn-3', 1_790_806_600)] },
      [NESTED]: { id: NESTED, name: 'Subagent', preview: '', cwd: project, updatedAt: 1_790_806_800, status: { type: 'idle' }, parentThreadId: THREAD, turns: [] }
    }
  }));
  const logFile = path.join(root, 'log.jsonl');
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, FAKE_CODEX_STATE: statePath, FAKE_CODEX_LOG: logFile, FAKE_CODEX_MODE: mode, CLAUDECODE: '1', T3_TOKEN: 'secret', OPENAI_API_KEY: 'user-key' };
  return {
    project, home, env,
    make: (options = {}) => createCodexHarness({ env, home, requestTimeoutMs: 5000, ...options }),
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
  };
}
const turn = (patch = {}) => Object.freeze({ jobId: 'job', harness: 'codex', conversationId: THREAD, message: 'Continue', messageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', commandId: 'c', deliveryKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ...patch });
async function send(s, adapter = s.make()) {
  const state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey });
  const { plan } = adapter.prepareTurn(turn(), state);
  return adapter.submitTurn(turn(), plan);
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

test('lists top-level threads with readable titles and project names', async () => {
  const s = setup({ status: { type: 'active', activeFlags: [] } });
  const list = await s.make().listConversations();
  assert.deepEqual(list.map((item) => item.id), [THREAD]);
  assert.equal(list[0].title, 'Please update the Ko-fi link');
  assert.equal(list[0].projectName, 'project');
  assert.equal(list[0].state, 'working');
  assert.equal(list[0].updatedAt, new Date(1_790_806_722_000).toISOString());
  assert.deepEqual(s.log().find((entry) => entry.method === 'thread/list').params, { limit: 100, sortKey: 'updated_at', archived: false });
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

test('submission resumes the thread with a client message ID, declines approvals and reports completion', async () => {
  const s = setup({ mode: 'approval' });
  const adapter = s.make();
  const result = await send(s, adapter);
  assert.equal(result.turnId, 'turn-4');
  const outcome = await result.completion;
  assert.equal(outcome.state, 'completed');
  const start = s.log().find((entry) => entry.method === 'turn/start');
  assert.equal(start.params.clientUserMessageId, turn().deliveryKey);
  assert.deepEqual(start.params.input, [{ type: 'text', text: 'Continue', text_elements: [] }]);
  assert.equal(s.log().find((entry) => entry.method === 'thread/resume').params.threadId, THREAD);
  assert.deepEqual(s.state().decisions, [{ decision: 'decline' }, { error: { code: -32601, message: 'Agent Auto-Continue runs unattended and cannot answer this request.' } }]);
  assert.equal(fs.realpathSync(s.log().filter((entry) => entry.start).at(-1).cwd), fs.realpathSync(s.project));
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  assert.equal((await s.make().checkTurn(turn())).state, 'completed', 'A new process reads the outcome back');
  assert.equal((await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: turn().deliveryKey })).delivered, true);
});

test('a usage-limit failure carries the account reset time', async () => {
  const s = setup({ mode: 'limit', rateLimits: { rateLimits: { primary: { usedPercent: 100, resetsAt: 4_102_444_800 }, secondary: null, rateLimitReachedType: 'rate_limit_reached' } } });
  const outcome = await (await send(s)).completion;
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'usage_limited');
  assert.equal(outcome.usageLimit.resetsAt, '2100-01-01T00:00:00.000Z');
});

test('rejections are certain, a crash after turn/start is uncertain', async () => {
  await assert.rejects(send(setup({ mode: 'reject' })), (error) => error.deliveryUncertain === false);
  await assert.rejects(send(setup({ mode: 'crash' })), (error) => error.deliveryUncertain === true && error.code === 'process_failed');
  const s = setup();
  const state = await s.make().inspectConversation({ conversationId: THREAD, deliveryKey: null });
  assert.throws(() => s.make().prepareTurn(turn(), { ...state, context: { cwd: path.join(s.home, 'gone') } }), { code: 'conversation_not_found' });
});

test('a long turn reports running, then interrupted after shutdown; a stale in-progress turn is unknown after restart', async () => {
  const s = setup({ mode: 'long' });
  const adapter = s.make();
  const result = await send(s, adapter);
  assert.equal((await adapter.checkTurn(turn())).state, 'running');
  assert.throws(() => adapter.prepareTurn(turn(), { context: { cwd: s.project } }), { code: 'conversation_busy' });
  await adapter.shutdown();
  assert.equal((await result.completion).state, 'interrupted');
  const stale = setup({ mode: 'long' });
  const first = stale.make();
  const pending = await send(stale, first);
  const restarted = stale.make();
  const checked = await restarted.checkTurn(turn());
  assert.equal(checked.state, 'unknown');
  await first.shutdown();
  await pending.completion;
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

test('server requests that need a person are declined in every protocol dialect', () => {
  assert.deepEqual(declineServerRequest('item/fileChange/requestApproval'), { decision: 'decline' });
  assert.deepEqual(declineServerRequest('execCommandApproval'), { decision: 'denied' });
  assert.deepEqual(declineServerRequest('applyPatchApproval'), { decision: 'denied' });
  assert.deepEqual(declineServerRequest('mcpServer/elicitation/request'), { action: 'decline', content: null });
  assert.equal(declineServerRequest('account/chatgptAuthTokens/refresh'), undefined);
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
});
