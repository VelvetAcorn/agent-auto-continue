'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ascendingMessageId, createOpenCodeHarness } = require('../lib/harnesses/opencode');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { JobService } = require('../lib/job-service');

const S1 = 'ses_f0b7c9d9bffe6G2Eso3S9T6xiu';
const S2 = 'ses_f0b7c37d1ffewQI7fumdkAEtBB';
const CHILD = 'ses_child000000000000000000';
const OLD = 'ses_archived0000000000000000';

// Fake OpenCode server implementing the documented endpoints the adapter uses.
function fakeServer({ password } = {}) {
  const state = {
    projects: [{ id: 'global', worktree: '/', time: {} }, { id: 'p-repo', worktree: '/work/repo', name: 'Repo', time: {} }],
    sessions: {
      [S1]: { id: S1, projectID: 'global', directory: '/work/scratch', title: 'Scratch', time: { created: 1, updated: 1_790_800_000_000 }, messages: [] },
      [S2]: { id: S2, projectID: 'p-repo', directory: '/work/repo', title: 'Repo work', time: { created: 1, updated: 1_790_900_000_000 }, messages: [
        { info: { id: 'msg_0000000000010000000000000', sessionID: S2, role: 'user', time: { created: 1_790_000_000_000 }, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude', variant: 'high' } }, parts: [] },
        { info: { id: 'msg_0000000000020000000000000', sessionID: S2, role: 'assistant', parentID: 'msg_0000000000010000000000000', time: { created: 1_790_000_001_000, completed: 1_790_000_002_000 } }, parts: [] }
      ] },
      [CHILD]: { id: CHILD, parentID: S2, projectID: 'p-repo', directory: '/work/repo', title: 'Subagent', time: { created: 1, updated: 1_790_950_000_000 }, messages: [] },
      [OLD]: { id: OLD, projectID: 'p-repo', directory: '/work/repo', title: 'Old', time: { created: 1, updated: 1_790_960_000_000, archived: 5 }, messages: [] }
    },
    status: {}, permissions: [], questions: [], requests: [], promptStatus: 204, html: false, reply: null
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      state.requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.authorization || '', body: body ? JSON.parse(body) : null });
      const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (password && request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`) return json({ error: 'unauthorized' }, 401);
      if (state.html) { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<!doctype html>secret'); }
      const parts = url.pathname.split('/').filter(Boolean);
      const session = state.sessions[parts[1]];
      const notFound = (what) => json({ name: 'NotFoundError', data: { message: `${what} not found: ${parts.at(-1)}` } }, 404);
      const bare = (item) => { const { messages, ...rest } = item; return rest; };
      if (url.pathname === '/global/health') return json({ healthy: true, version: '1.18.34' });
      if (url.pathname === '/project') return json(state.projects);
      if (url.pathname === '/project/current') return json(state.projects.find((project) => project.worktree === url.searchParams.get('directory')) || state.projects[0]);
      if (url.pathname === '/session/status') return json(state.status);
      if (url.pathname === '/permission') return json(state.permissions);
      if (url.pathname === '/question') return json(state.questions);
      if (url.pathname === '/session') {
        const directory = url.searchParams.get('directory');
        return json(Object.values(state.sessions).filter((item) => (directory ? item.directory === directory : item.projectID === 'global') || item.id === S1).map(bare));
      }
      if (parts[0] !== 'session') return json({}, 404);
      if (!session) return notFound('Session');
      if (parts.length === 2) return json(bare(session));
      if (parts[2] === 'message' && parts.length === 3) {
        const limit = Number(url.searchParams.get('limit') || 1000);
        return json(session.messages.slice(-limit));
      }
      if (parts[2] === 'message' && parts[3]) {
        const found = session.messages.find((message) => message.info.id === parts[3]);
        return found ? json(found) : notFound('Message');
      }
      if (parts[2] === 'prompt_async' && request.method === 'POST') {
        if (state.promptStatus !== 204) return json({ name: 'Error' }, state.promptStatus);
        const input = JSON.parse(body);
        const existing = session.messages.findIndex((message) => message.info.id === input.messageID);
        const message = { info: { id: input.messageID, sessionID: session.id, role: 'user', time: { created: Date.now() }, agent: input.agent, model: input.model }, parts: input.parts };
        if (existing >= 0) session.messages[existing] = message; else session.messages.push(message);
        if (state.reply) session.messages.push({ info: { id: `${input.messageID}R`, sessionID: session.id, role: 'assistant', parentID: input.messageID, ...state.reply }, parts: [] });
        response.writeHead(204); return response.end();
      }
      return json({}, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => new Promise((done) => server.close(done)) })));
}
const turn = (patch = {}) => Object.freeze({ jobId: 'job', harness: 'opencode', conversationId: S2, message: 'Continue', messageId: 'uuid', commandId: 'c', deliveryKey: 'uuid', ...patch });
const adapterFor = (server, extra = {}) => createOpenCodeHarness({ getSettings: () => ({ port: server.port, ...extra }), env: {}, timeoutMs: 2000 });

test('connection checks use loopback, basic auth and friendly failures', async (t) => {
  const server = await fakeServer({ password: 'server-secret' });
  t.after(server.close);
  await assert.rejects(adapterFor(server).checkConnection(), (error) => error.code === 'authentication_rejected' && /requires a server password/.test(error.message));
  await assert.rejects(adapterFor(server, { password: 'wrong' }).checkConnection(), (error) => error.code === 'authentication_rejected' && !JSON.stringify(error).includes('wrong'));
  assert.deepEqual(await adapterFor(server, { password: 'server-secret' }).checkConnection(), { ok: true, version: '1.18.34' });
  const envPassword = createOpenCodeHarness({ getSettings: () => ({ port: server.port, password: 'server-secret' }), env: { OPENCODE_SERVER_USERNAME: 'someone' } });
  await assert.rejects(envPassword.checkConnection(), { code: 'authentication_rejected' }, 'The username override is sent');
  server.state.html = true;
  await assert.rejects(adapterFor(server, { password: 'server-secret' }).checkConnection(), (error) => error.code === 'unexpected_response_format' && !error.message.includes('secret'));
  await server.close();
  await assert.rejects(adapterFor(server).checkConnection(), (error) => error.code === 'connection_refused' && /opencode serve --port/.test(error.message));
});

test('lists root sessions across projects without archived or child sessions', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  server.state.status = { [S2]: { type: 'busy' } };
  const list = await adapterFor(server).listConversations();
  assert.deepEqual(list.map((item) => item.id), [S2, S1]);
  assert.equal(list[0].projectName, 'Repo');
  assert.equal(list[0].state, 'working');
  assert.equal(list[1].projectName, 'scratch');
  assert.equal(list[1].state, 'idle');
  assert.equal(list[0].updatedAt, new Date(1_790_900_000_000).toISOString());
  assert.ok(server.state.requests.some((request) => request.path === '/session' && request.query.directory === '/work/repo' && request.query.roots === 'true'));
});

test('inspection reports user activity, pending prompts, busy state and delivery', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  server.state.permissions = [{ id: 'per_1', sessionID: S2 }];
  server.state.status = { [S2]: { type: 'retry', attempt: 1, message: 'Rate limited', next: 1 } };
  const adapter = adapterFor(server);
  const state = await adapter.inspectConversation({ conversationId: S2, deliveryKey: 'msg_0000000000010000000000000' });
  assert.equal(state.latestUserActivityAt, new Date(1_790_000_000_000).toISOString());
  assert.equal(state.delivered, true);
  assert.equal(state.awaitingInput, true);
  assert.equal(state.busy, true);
  assert.equal(state.projectName, 'Repo');
  assert.equal(state.context.directory, '/work/repo');
  server.state.permissions = [];
  assert.equal((await adapter.inspectConversation({ conversationId: S1, deliveryKey: 'uuid-not-opencode' })).awaitingInput, false);
  await assert.rejects(adapter.inspectConversation({ conversationId: 'ses_missing', deliveryKey: null }), { code: 'conversation_not_found' });
  await assert.rejects(adapter.inspectConversation({ conversationId: '../global/health', deliveryKey: null }), { code: 'conversation_not_found' });
});

test('sending continues with the last agent and model under an ascending, idempotent message ID', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  const adapter = adapterFor(server);
  const state = await adapter.inspectConversation({ conversationId: S2, deliveryKey: 'uuid' });
  const { deliveryKey, plan } = adapter.prepareTurn(turn(), state);
  assert.match(deliveryKey, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.deepEqual(plan.body, { messageID: deliveryKey, parts: [{ type: 'text', text: 'Continue' }], agent: 'build', model: { providerID: 'anthropic', modelID: 'claude' }, variant: 'high' });
  const result = await adapter.submitTurn(turn({ deliveryKey }), plan);
  assert.equal(result.turnId, deliveryKey);
  const post = server.state.requests.find((request) => request.method === 'POST');
  assert.equal(post.path, `/session/${S2}/prompt_async`);
  assert.equal(post.query.directory, '/work/repo');
  assert.equal((await adapter.findDelivery(turn({ deliveryKey }))).delivered, true);
  assert.equal((await adapter.findDelivery(turn({ deliveryKey: 'msg_ffffffffffff00000000000000' }))).delivered, false);
  await adapter.submitTurn(turn({ deliveryKey }), plan);
  assert.equal(server.state.sessions[S2].messages.filter((message) => message.info.id === deliveryKey).length, 1, 'Resending the same ID does not duplicate');
  const empty = adapter.prepareTurn(turn({ conversationId: S1 }), await adapter.inspectConversation({ conversationId: S1, deliveryKey: null }));
  assert.equal(empty.plan.body.model, undefined, 'Without a previous user message the server default applies');
});

test('ascending message IDs sort by creation time', () => {
  const ids = [ascendingMessageId(1_790_000_000_000), ascendingMessageId(1_790_000_000_000), ascendingMessageId(1_790_000_000_001), ascendingMessageId(1_890_000_000_000)];
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, 4);
});

test('client errors are certain, server errors and timeouts are uncertain', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  const adapter = adapterFor(server);
  const { plan } = adapter.prepareTurn(turn(), await adapter.inspectConversation({ conversationId: S2, deliveryKey: null }));
  server.state.promptStatus = 400;
  await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.code === 'http_failure' && error.deliveryUncertain === false);
  server.state.promptStatus = 500;
  await assert.rejects(adapter.submitTurn(turn(), plan), (error) => error.deliveryUncertain === true);
  const hanging = http.createServer(() => { /* Never answers. */ });
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { hanging.closeAllConnections(); hanging.close(resolve); }));
  const slow = createOpenCodeHarness({ getSettings: () => ({ port: hanging.address().port }), env: {}, timeoutMs: 100 });
  await assert.rejects(slow.submitTurn(turn(), plan), (error) => error.code === 'timeout' && error.deliveryUncertain === true);
});

test('turn outcomes come from session status and the reply to the sent message', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  const adapter = adapterFor(server);
  const sent = turn({ deliveryKey: 'msg_0000000000010000000000000' });
  server.state.status = { [S2]: { type: 'busy' } };
  assert.equal((await adapter.checkTurn(sent)).state, 'running');
  server.state.status = { [S2]: { type: 'retry', attempt: 2, message: 'You have hit your usage limit', next: 4_102_444_800_000 } };
  const retrying = await adapter.checkTurn(sent);
  assert.equal(retrying.state, 'running');
  assert.equal(retrying.usageLimit.resetsAt, '2100-01-01T00:00:00.000Z');
  server.state.status = {};
  assert.equal((await adapter.checkTurn(sent)).state, 'completed');
  const reply = server.state.sessions[S2].messages[1].info;
  reply.error = { name: 'APIError', data: { message: 'Too many requests', statusCode: 429, isRetryable: false } };
  const limited = await adapter.checkTurn(sent);
  assert.equal(limited.state, 'failed');
  assert.equal(limited.error.code, 'usage_limited');
  reply.error = { name: 'MessageAbortedError', data: {} };
  assert.equal((await adapter.checkTurn(sent)).state, 'interrupted');
  assert.equal((await adapter.checkTurn(turn({ deliveryKey: 'msg_nothing00000000000000000' }))).state, 'unknown');
});

test('availability reports a limit only while a session waits on one', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  const adapter = adapterFor(server);
  assert.equal((await adapter.probeAvailability()).state, 'unknown');
  server.state.status = { [S1]: { type: 'retry', attempt: 1, message: 'Overloaded', next: 1 }, [S2]: { type: 'retry', attempt: 3, message: 'Rate limit reached', next: 4_102_444_800_000, action: { reason: 'rate_limit', provider: 'anthropic', title: 'Usage limit reached', message: '', label: 'Upgrade' } } };
  const limited = await adapter.probeAvailability();
  assert.equal(limited.state, 'limited');
  assert.equal(limited.source, 'inferred');
  assert.equal(limited.resetsAt, '2100-01-01T00:00:00.000Z');
  assert.equal(limited.reason, 'Usage limit reached');
});

test('an OpenCode job is scheduled, delivered once and completed through the job service', async (t) => {
  const server = await fakeServer();
  t.after(server.close);
  server.state.reply = { time: { created: Date.now(), completed: Date.now() } };
  let clock = Date.now() + 60_000;
  const service = new JobService({ harnesses: createHarnessRegistry([adapterFor(server)]), now: () => clock, persist: () => {}, scheduleTimer: () => ({ cancel() {} }) });
  const job = await service.create({ harness: 'opencode', threadId: S2, message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC' });
  assert.equal(job.threadTitle, 'Repo work');
  assert.equal(job.baselineUserTurnAt, new Date(1_790_000_000_000).toISOString());
  clock += 120_000;
  await service.run(job.id);
  const sent = service.get(job.id);
  assert.equal(sent.status, 'sent');
  assert.match(sent.deliveryKey, /^msg_/);
  await service.pollTurns();
  assert.equal(service.get(job.id).turn.state, 'completed');
  assert.equal(server.state.requests.filter((request) => request.method === 'POST').length, 1);
});
