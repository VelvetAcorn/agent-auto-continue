'use strict';
// End-to-end MCP checks over real HTTP using the official SDK clients:
// @modelcontextprotocol/sdk v1 speaks the 2025-11-25 initialize handshake,
// @modelcontextprotocol/client v2 speaks the stateless 2026-07-28 protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client: LegacyClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport: LegacyTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { startRemote } = require('./remote-fixture');

const READ_TOOLS = ['check_connection', 'get_availability', 'get_job', 'get_status', 'list_harnesses', 'list_jobs', 'list_projects', 'list_threads'];
const CONTROL_TOOLS = [...READ_TOOLS, 'acknowledge_job', 'cancel_job', 'edit_job', 'mark_not_delivered', 'reconcile_job', 'schedule_message'].sort();

async function connect(f, { era, token = f.control.token, headers = {} }) {
  const requestInit = { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } };
  const url = new URL(`${f.base}/mcp`);
  const client = era === 'legacy' ? new LegacyClient({ name: 'legacy-test', version: '1.0.0' }) :
    new Client({ name: 'modern-test', version: '1.0.0' }, { versionNegotiation: { mode: era === 'auto' ? 'auto' : { pin: '2026-07-28' } } });
  await client.connect(era === 'legacy' ? new LegacyTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit }));
  return client;
}

for (const era of ['legacy', 'modern']) {
  test(`${era} MCP client can run the full scheduling workflow`, async (t) => {
    const f = await startRemote();
    t.after(f.close);
    const client = await connect(f, { era });
    t.after(() => client.close());
    if (era === 'modern') assert.equal(client.getProtocolEra(), 'modern');
    else assert.equal(client.getServerVersion().name, 'agent-auto-continue');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), CONTROL_TOOLS);
    const schedule = tools.find((tool) => tool.name === 'schedule_message');
    assert.deepEqual(schedule.inputSchema.required, ['threadId']);
    assert.equal(schedule.inputSchema.additionalProperties, false);
    assert.equal(tools.find((tool) => tool.name === 'list_jobs').annotations.readOnlyHint, true);
    assert.equal(tools.find((tool) => tool.name === 'cancel_job').annotations.destructiveHint, true);

    const status = await client.callTool({ name: 'get_status', arguments: {} });
    assert.equal(status.structuredContent.harnesses[0].online, true);
    assert.equal(status.structuredContent.caller.label, "Ryan's iPhone");
    const threads = await client.callTool({ name: 'list_threads', arguments: { showSettled: true } });
    assert.deepEqual(threads.structuredContent.threads.map((thread) => thread.id), ['thread-b', 'thread-a']);

    const created = await client.callTool({ name: 'schedule_message', arguments: { threadId: 'thread-a', delayMinutes: 30, idempotencyKey: `mcp-${era}` } });
    assert.equal(created.isError, undefined);
    const job = created.structuredContent.job;
    assert.equal(job.message, 'Continue');
    assert.equal(JSON.parse(created.content[0].text).job.id, job.id, 'text content mirrors structured content');
    const replay = await client.callTool({ name: 'schedule_message', arguments: { threadId: 'thread-a', delayMinutes: 30, idempotencyKey: `mcp-${era}` } });
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(replay.structuredContent.job.id, job.id);
    assert.equal(f.service.jobs.length, 1);

    const edited = await client.callTool({ name: 'edit_job', arguments: { id: job.id, message: 'Keep going' } });
    assert.equal(edited.structuredContent.job.message, 'Keep going');
    assert.equal((await client.callTool({ name: 'get_job', arguments: { id: job.id } })).structuredContent.job.message, 'Keep going');
    assert.equal((await client.callTool({ name: 'list_jobs', arguments: { view: 'upcoming' } })).structuredContent.total, 1);
    const canceled = await client.callTool({ name: 'cancel_job', arguments: { id: job.id } });
    assert.equal(canceled.structuredContent.job.status, 'canceled');
    assert.equal(f.service.get(job.id).status, 'canceled');

    const conflict = await client.callTool({ name: 'cancel_job', arguments: { id: job.id } });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.error.code, 'invalid_state');
    const invalid = await client.callTool({ name: 'schedule_message', arguments: { threadId: 'thread-a', whenISO: '2020-01-01T00:00:00Z' } });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.content[0].text, 'validation_failed: The scheduled time must be in the future.');
    const wrongType = await client.callTool({ name: 'schedule_message', arguments: { threadId: 42 } });
    assert.equal(wrongType.isError, true);
    const audit = f.remote.getState().audit.filter((entry) => entry.transport === 'mcp');
    assert.ok(audit.some((entry) => entry.action === 'createJob' && entry.outcome === 'ok' && entry.tokenLabel === "Ryan's iPhone"));
    assert.ok(audit.some((entry) => entry.action === 'cancelJob' && entry.outcome === 'error'));
    assert.equal(f.harness.dispatches, 0);
  });

  test(`${era} MCP client with a read-only token only sees read tools and cannot mutate`, async (t) => {
    const f = await startRemote();
    t.after(f.close);
    const client = await connect(f, { era, token: f.read.token });
    t.after(() => client.close());
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), READ_TOOLS);
    const attempt = await client.callTool({ name: 'schedule_message', arguments: { threadId: 'thread-a', delayMinutes: 5 } }).catch((error) => ({ rejected: error }));
    assert.ok(attempt.rejected || attempt.isError, 'unknown tool for this token');
    assert.equal(f.service.jobs.length, 0);
  });
}

test('automatic version negotiation selects the modern protocol', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const client = await connect(f, { era: 'auto' });
  t.after(() => client.close());
  assert.equal(client.getProtocolEra(), 'modern');
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
});

test('MCP endpoint rejects missing tokens and disallowed browser origins before any MCP processing', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  for (const era of ['legacy', 'modern']) {
    await assert.rejects(connect(f, { era, token: null }));
    await assert.rejects(connect(f, { era, headers: { Origin: 'https://evil.example' } }));
  }
  const get = await f.request('GET', '/mcp', { headers: { Accept: 'text/event-stream', 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(get.status, 405, 'no standalone SSE stream is offered');
  assert.equal(f.remote.getState().audit.filter((entry) => entry.action === 'authenticate').length, 2);
});
