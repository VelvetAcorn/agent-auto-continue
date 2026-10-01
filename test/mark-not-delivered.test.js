'use strict';
// "Mark as not delivered": the user asserts that an unconfirmed delivery did not arrive.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HarnessError } = require('../lib/harnesses/errors');
const { MIN, serviceFixture } = require('./service-fixture');
const { startRemote } = require('./remote-fixture');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

// A schedule whose send may have arrived: the harness took the message but could not confirm it.
async function unconfirmed(h, patch = {}) {
  const created = await h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', whenISO: h.iso(MIN), timeZone: 'UTC', ...patch });
  h.fake.state.submitError = new HarnessError('timeout', 'The app did not confirm the message.', {}, true);
  await h.advance(MIN + 5_000);
  h.fake.state.submitError = null;
  assert.equal(h.view(created.id).deliveryStatus, 'unconfirmed');
  return created;
}

test('marking a one-off delivery as not delivered needs confirmation, checks once more, and makes it failed and schedulable again', async () => {
  const h = serviceFixture();
  const created = await unconfirmed(h);
  const before = h.get(created.id);
  assert.equal(h.view(created.id).canMarkNotDelivered, true);
  await assert.rejects(h.service.markNotDelivered(created.id), /Confirm that the message did not arrive/);
  await assert.rejects(h.service.markNotDelivered(created.id, { confirm: 'yes' }), /Confirm that the message did not arrive/);
  assert.throws(() => h.service.scheduleAgain(created.id), /Confirm the previous delivery/);
  const marked = await h.service.markNotDelivered(created.id, { confirm: true });
  assert.deepEqual([marked.status, marked.deliveryStatus, marked.deliveryCertainty, marked.error.code], ['failed', 'failed', 'not-delivered', 'marked_not_delivered']);
  assert.equal(marked.note, 'You marked this message as not delivered.');
  assert.equal(marked.canMarkNotDelivered, false);
  assert.equal(marked.needsAttention, false, 'The user has dealt with it');
  assert.deepEqual(marked.notDeliveredMarks, [{ at: h.iso(0), source: 'desktop', messageId: before.messageId, deliveryKey: before.deliveryKey, attemptedAt: before.dispatchAttemptedAt }]);
  assert.equal(h.fake.state.calls.filter(([name]) => name === 'findDelivery').length, 1, 'One read-only check first');
  assert.equal(h.service.scheduleAgain(created.id).message, 'Continue');
  await assert.rejects(h.service.markNotDelivered(created.id, { confirm: true }), (error) => error.code === 'invalid_state' && /Only unconfirmed deliveries/.test(error.message));
  assert.equal(h.fake.state.submitted.length, 0, 'Nothing is ever sent by marking');
});

test('a delivery the final check can prove is confirmed instead of being marked', async () => {
  const h = serviceFixture();
  const created = await unconfirmed(h);
  const job = h.get(created.id);
  h.fake.state.conversations.get('conv').messages.push({ id: job.deliveryKey, role: 'user', createdAt: h.iso(0) });
  await assert.rejects(h.service.markNotDelivered(created.id, { confirm: true }), (error) => error.code === 'invalid_state' && /found in the session, so its delivery is now confirmed/.test(error.message));
  const confirmed = h.view(created.id);
  assert.deepEqual([confirmed.deliveryStatus, confirmed.deliveryCertainty, confirmed.notDeliveredMarks], ['sent', 'delivered', undefined]);
});

test('a final check that cannot run does not stop the user from marking', async () => {
  const h = serviceFixture();
  const created = await unconfirmed(h);
  h.fake.state.conversations.delete('conv');
  const marked = await h.service.markNotDelivered(created.id, { confirm: true, source: 'remote' });
  assert.deepEqual([marked.deliveryStatus, marked.notDeliveredMarks[0].source], ['failed', 'remote']);
  await assert.rejects(h.service.markNotDelivered(created.id, { confirm: true, source: 'phone' }), /Invalid source|Only unconfirmed/);
});

test('only unconfirmed deliveries can be marked', async () => {
  const h = serviceFixture();
  const pending = await h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', whenISO: h.iso(10 * MIN), timeZone: 'UTC' });
  await assert.rejects(h.service.markNotDelivered(pending.id, { confirm: true }), { code: 'invalid_state' });
  await assert.rejects(h.service.markNotDelivered('missing', { confirm: true }), { code: 'not_found' });
});

test('a paused continuation marked as not delivered resends that turn on Resume with a new delivery key, and remembers the assertion across a restart', async () => {
  const h = serviceFixture();
  const created = await unconfirmed(h, { trigger: 'time', turnLimit: 3 });
  const paused = h.view(created.id);
  assert.deepEqual([paused.automation.state, paused.automation.reasonCode, paused.canResume], ['paused', 'delivery_unconfirmed', false]);
  assert.throws(() => h.service.resumeChain(created.id), /Check delivery before resuming/);
  const first = h.get(created.id);
  const firstKey = first.deliveryKey;
  const marked = await h.service.markNotDelivered(created.id, { confirm: true, source: 'tray' });
  assert.deepEqual([marked.automation.state, marked.automation.reasonCode, marked.canResume], ['paused', 'marked_not_delivered', true]);
  assert.equal(marked.automation.reason, 'You marked the last message as not delivered. Resume to send that turn again.');
  assert.equal(marked.automation.sentTurns, 0, 'The unconfirmed turn was never counted');
  // Quit and relaunch before resuming: nothing is sent, and the assertion is kept.
  const restarted = h.restart();
  assert.deepEqual([restarted.get(created.id).status, restarted.get(created.id).notDeliveredMarks.length], ['failed', 1]);
  await h.advance(10 * MIN);
  assert.equal(h.fake.state.submitted.length, 0);
  const resumed = h.service.resumeChain(created.id);
  assert.equal(resumed.automation.state, 'active');
  assert.notEqual(resumed.messageId, first.messageId);
  await h.advance(10_000);
  const resent = h.get(created.id);
  assert.equal(resent.status, 'sent');
  assert.equal(h.fake.state.submitted.length, 1);
  assert.notEqual(h.fake.state.submitted[0].deliveryKey, firstKey, 'A new delivery key, so the turns cannot be confused');
  assert.equal(resent.deliveryKey, h.fake.state.submitted[0].deliveryKey);
  assert.deepEqual(resent.notDeliveredMarks.map((mark) => [mark.source, mark.deliveryKey]), [['tray', firstKey]]);
  await h.finish(1);
  assert.equal(h.view(created.id).automation.sentTurns, 1);
});

test('remote control marks over REST only with confirm: true, audits it and refuses read-only tokens', async (t) => {
  const base = { commandId: 'c', threadId: 'thread-a', message: 'Continue', scheduleAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z', bufferSeconds: 5 };
  const f = await startRemote({ jobs: [{ ...base, id: 'uncertain', messageId: 'm2', status: 'unconfirmed', dispatchAttemptedAt: '2026-01-01T10:00:05Z' }, { ...base, id: 'sent', messageId: 'm3', status: 'sent' }] });
  t.after(f.close);
  const path = '/v1/jobs/uncertain/mark-not-delivered';
  const missing = await f.request('POST', path);
  assert.deepEqual([missing.status, missing.body.error.code], [400, 'validation_failed']);
  assert.match(missing.body.error.message, /confirm/);
  assert.equal((await f.request('POST', path, { body: { confirm: false } })).status, 400);
  assert.equal((await f.request('POST', path, { body: { confirm: true, extra: 1 } })).status, 400);
  assert.equal((await f.request('POST', path, { body: { confirm: true }, token: f.read.token })).status, 403);
  assert.equal(f.service.get('uncertain').status, 'unconfirmed', 'Nothing changed yet');
  const marked = await f.request('POST', path, { body: { confirm: true } });
  assert.equal(marked.status, 200);
  assert.deepEqual([marked.body.job.deliveryStatus, marked.body.job.error.code, marked.body.job.notDeliveredMarks[0].source], ['failed', 'marked_not_delivered', 'remote']);
  const again = await f.request('POST', path, { body: { confirm: true } });
  assert.deepEqual([again.status, again.body.error.code], [409, 'invalid_state']);
  assert.equal((await f.request('POST', '/v1/jobs/sent/mark-not-delivered', { body: { confirm: true } })).status, 409);
  assert.equal((await f.request('POST', '/v1/jobs/nope/mark-not-delivered', { body: { confirm: true } })).status, 404);
  const audit = f.remote.getState().audit.filter((entry) => entry.action === 'markNotDelivered');
  assert.ok(audit.some((entry) => entry.outcome === 'ok' && entry.target === 'uncertain' && entry.tokenLabel === "Ryan's iPhone" && entry.transport === 'http'));
  assert.ok(audit.some((entry) => entry.outcome === 'denied' && entry.tokenLabel === 'Dashboard'));
  assert.ok(audit.some((entry) => entry.outcome === 'error' && /invalid_state/.test(entry.error)));
  assert.equal(f.harness.dispatches, 0);
});

test('the MCP mark_not_delivered tool needs confirm: true', async (t) => {
  const base = { commandId: 'c', threadId: 'thread-a', message: 'Continue', scheduleAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z', bufferSeconds: 5 };
  const f = await startRemote({ jobs: [{ ...base, id: 'uncertain', messageId: 'm2', status: 'unconfirmed' }] });
  t.after(f.close);
  const client = new Client({ name: 'mark-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${f.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${f.control.token}` } } }));
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((item) => item.name === 'mark_not_delivered');
  assert.deepEqual(tool.inputSchema.required.sort(), ['confirm', 'id']);
  assert.equal(tool.annotations.destructiveHint, true);
  const refused = await client.callTool({ name: 'mark_not_delivered', arguments: { id: 'uncertain' } });
  assert.equal(refused.isError, true);
  const marked = await client.callTool({ name: 'mark_not_delivered', arguments: { id: 'uncertain', confirm: true } });
  assert.equal(marked.structuredContent.job.deliveryStatus, 'failed');
  assert.ok(f.remote.getState().audit.some((entry) => entry.action === 'markNotDelivered' && entry.transport === 'mcp' && entry.outcome === 'ok'));
});

test('remote control creates and edits a stop phrase with the composer rules', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const created = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30, turnLimit: 3, stopPhrase: 'TASK COMPLETE' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.job.automation.stopPhrase, 'TASK COMPLETE');
  const single = await f.request('POST', '/v1/jobs', { body: { threadId: 'thread-a', delayMinutes: 30, stopPhrase: 'TASK COMPLETE' } });
  assert.deepEqual([single.status, single.body.error.code], [400, 'validation_failed']);
  assert.match(single.body.error.message, /more than one turn/);
  const path = `/v1/jobs/${created.body.job.id}`;
  const changed = await f.request('PATCH', path, { body: { stopPhrase: 'ALL DONE' } });
  assert.deepEqual([changed.status, changed.body.job.automation.stopPhrase, changed.body.job.automation.limit], [200, 'ALL DONE', 3]);
  const kept = await f.request('PATCH', path, { body: { message: 'Keep going' } });
  assert.equal(kept.body.job.automation.stopPhrase, 'ALL DONE', 'An edit without the field keeps it');
  const cleared = await f.request('PATCH', path, { body: { stopPhrase: null } });
  assert.equal(cleared.body.job.automation.stopPhrase, null);
  assert.equal((await f.request('PATCH', path, { body: { stopPhrase: 'x'.repeat(500) } })).status, 400);
  assert.equal(f.harness.dispatches, 0);
});
