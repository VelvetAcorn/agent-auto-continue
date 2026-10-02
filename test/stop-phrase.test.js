'use strict';
// Opt-in stop phrase: a chain finishes with reason stop_phrase when a completed turn's final
// agent message contains the phrase. The message comes from the turn outcome's lastAgentMessage.
const test = require('node:test');
const assert = require('node:assert/strict');
const continuation = require('../lib/continuation');
const { JobService } = require('../lib/job-service');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { createT3Harness, lastAgentMessage, turnOutcomeFor } = require('../lib/harnesses/t3');
const { MAX_AGENT_MESSAGE_CHARS, turnOutcome } = require('../lib/harnesses/contract');
const { MIN, serviceFixture } = require('./service-fixture');
const compose = require('../renderer/compose');

const chain = (h, patch = {}) => h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 5, stopPhrase: 'TASK COMPLETE', ...patch });

test('stop phrase input is trimmed, collapsed, bounded and needs more than one turn', () => {
  assert.equal(continuation.validateStopPhrase('  Task\n  complete  '), 'Task complete');
  for (const blank of [undefined, null, '', '   ']) assert.equal(continuation.validateStopPhrase(blank), null);
  assert.throws(() => continuation.validateStopPhrase('ok'), /between 3 and 200 characters/);
  assert.throws(() => continuation.validateStopPhrase('x'.repeat(201)), /between 3 and 200 characters/);
  assert.throws(() => continuation.validateStopPhrase(42), /must be text/);
  assert.deepEqual(continuation.validateAutomation({ turnLimit: 3, stopPhrase: ' DONE ' }), { trigger: 'time', limit: 3, stopPhrase: 'DONE' });
  assert.deepEqual(continuation.validateAutomation({ continuous: true, stopPhrase: 'DONE' }), { trigger: 'time', limit: null, stopPhrase: 'DONE' });
  assert.throws(() => continuation.validateAutomation({ stopPhrase: 'DONE' }), /only applies when more than one turn/);
  assert.throws(() => continuation.validateAutomation({ trigger: 'available', turnLimit: 1, stopPhrase: 'DONE' }), /only applies when more than one turn/);
});

test('the stop phrase matches as whole words anywhere in the message, ignoring case and whitespace differences', () => {
  for (const text of ['All done. TASK COMPLETE', 'task complete', '**Task   Complete**', 'Summary:\nTask\ncomplete.', 'The task completed? No: task complete!']) assert.equal(continuation.matchesStopPhrase('TASK COMPLETE', text), true, text);
  for (const text of ['Task completed', 'Multitask complete', 'TASK', '', null, undefined]) assert.equal(continuation.matchesStopPhrase('TASK COMPLETE', text), false, String(text));
  assert.equal(continuation.matchesStopPhrase('DONE', 'I abandoned the refactor.'), false, 'Part of a word never matches');
  assert.equal(continuation.matchesStopPhrase('DONE', 'Done.'), true);
  assert.equal(continuation.matchesStopPhrase('<done/>', 'Finished<done/>'), true, 'Punctuation at the edges needs no word boundary');
  assert.equal(continuation.matchesStopPhrase('Ready ✅', 'All set: ready ✅'), true);
  assert.equal(continuation.matchesStopPhrase('fertig', 'Alles erledigt: FERTIG'), true);
});

test('the agent message is optional in the turn outcome contract, kept from its end and never blank', () => {
  assert.equal(turnOutcome({ state: 'completed' }).lastAgentMessage, null);
  assert.equal(turnOutcome({ state: 'completed', lastAgentMessage: '  ' }).lastAgentMessage, null);
  assert.equal(turnOutcome({ state: 'completed', lastAgentMessage: 42 }).lastAgentMessage, null);
  const long = `${'x'.repeat(MAX_AGENT_MESSAGE_CHARS)}TASK COMPLETE`;
  const kept = turnOutcome({ state: 'completed', lastAgentMessage: long }).lastAgentMessage;
  assert.equal(kept.length, MAX_AGENT_MESSAGE_CHARS);
  assert.ok(kept.endsWith('TASK COMPLETE'));
});

test('a chain finishes with stop_phrase when a completed turn ends with the phrase, and the agent text is never stored', async () => {
  const h = serviceFixture();
  const created = await chain(h);
  assert.equal(created.chain.stopPhrase, 'TASK COMPLETE');
  assert.equal(created.automation.stopPhrase, 'TASK COMPLETE');
  await h.advance(5_000);
  await h.advance(2 * MIN);
  await h.finish(1, { lastAgentMessage: 'Fixed two tests; three remain.' });
  assert.equal(h.get(created.id).chain.history[0].stopPhraseMatched, false);
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2);
  await h.advance(2 * MIN);
  await h.finish(2, { lastAgentMessage: 'All tests pass. Secret detail 7f3a.\n\nTask complete.' });
  const done = h.view(created.id);
  assert.deepEqual([done.automation.state, done.automation.reasonCode], ['finished', 'stop_phrase']);
  assert.equal(done.automation.reason, 'Finished after 2 turns: the agent\'s last message contained the stop phrase “TASK COMPLETE”. No further message was sent.');
  assert.equal(done.turn.stopPhraseMatched, true);
  assert.equal(done.automation.turns.at(-1).stopPhraseMatched, true);
  assert.deepEqual(h.notifications.at(-1), ['Continuation finished', `Fake Agent: ${done.automation.reason}`]);
  await h.advance(60 * MIN);
  assert.equal(h.fake.state.submitted.length, 2, 'Nothing further is sent');
  assert.deepEqual(h.service.activeWork(), []);
  assert.doesNotMatch(JSON.stringify(h.stored), /Secret detail|three remain/, 'The agent message is read, not persisted');
});

test('only a completed turn with a reported message can end the chain', async () => {
  const h = serviceFixture();
  const created = await chain(h);
  await h.advance(5_000);
  await h.finish(1, {});
  assert.equal(h.get(created.id).chain.history[0].stopPhraseMatched, null, 'No message reported: unknown, and the chain continues');
  await h.advance(5_000);
  await h.finish(2, { state: 'failed', error: { code: 'agent_error', message: 'Crashed' }, lastAgentMessage: 'TASK COMPLETE' });
  const paused = h.view(created.id);
  assert.deepEqual([paused.automation.state, paused.automation.reasonCode], ['paused', 'turn_failed'], 'A failed turn pauses as before, even with the phrase');
  assert.equal(paused.turn.stopPhraseMatched, undefined);
});

test('a chain without a stop phrase ignores the agent message', async () => {
  const h = serviceFixture();
  const created = await chain(h, { stopPhrase: undefined, turnLimit: 2 });
  assert.equal(created.chain.stopPhrase, null);
  await h.advance(5_000);
  await h.finish(1, { lastAgentMessage: 'TASK COMPLETE' });
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2);
  assert.equal(h.get(created.id).chain.history[0].stopPhraseMatched, undefined);
});

test('a harness that cannot report the agent message refuses a stop phrase with the reason', async () => {
  const h = serviceFixture({ capabilities: { canReportAgentMessage: false } });
  const support = continuation.automationSupport(h.fake.adapter);
  assert.equal(support.stopPhrase.supported, false);
  assert.equal(support.stopPhrase.reason, 'Fake Agent does not report the agent\'s last message, so a stop phrase cannot be detected. Use a turn limit instead.');
  await assert.rejects(chain(h), /does not report the agent's last message/);
  assert.equal((await chain(h, { stopPhrase: '' })).chain.stopPhrase, null, 'Without a phrase the chain is allowed');
  assert.match(continuation.automationSupport(createT3Harness({ api: {} })).stopPhrase.reason, /T3 Code reports the agent's last message/);
});

test('a finished turn with the phrase whose follow-up was not written finishes the chain at restart', async () => {
  const h = serviceFixture();
  const created = await chain(h);
  await h.advance(5_000);
  // The completed outcome was saved, but the app quit before the chain's next step was written.
  const job = h.get(created.id);
  h.service.patch(job, { turn: { ...job.turn, state: 'completed', completedAt: h.iso(0), stopPhraseMatched: true } });
  const restarted = h.restart();
  const recovered = restarted.present(restarted.get(created.id));
  assert.deepEqual([recovered.automation.state, recovered.automation.reasonCode], ['finished', 'stop_phrase']);
  await h.advance(60 * MIN);
  assert.equal(h.fake.state.submitted.length, 1);
});

test('resuming a paused chain whose last turn said the phrase finishes it instead of sending again', async () => {
  const h = serviceFixture();
  const created = await chain(h);
  await h.advance(5_000);
  const job = h.get(created.id);
  h.service.patch(job, h.service.chainPatch(job, 'paused', 'app_version_unsupported', 'The app changed.'));
  await h.finish(1, { lastAgentMessage: 'TASK COMPLETE' });
  assert.equal(h.get(created.id).turn.stopPhraseMatched, true, 'Recorded while paused');
  const resumed = h.service.resumeChain(created.id);
  assert.deepEqual([resumed.automation.state, resumed.automation.reasonCode], ['finished', 'stop_phrase']);
  await h.advance(10 * MIN);
  assert.equal(h.fake.state.submitted.length, 1);
});

test('the stop phrase can be set, kept, cleared and carried over before a chain starts', async () => {
  const h = serviceFixture();
  h.fake.state.availability = { state: 'limited', resetsAt: h.iso(5 * 60 * MIN), source: 'reported' };
  const created = await chain(h, { stopPhrase: undefined });
  const set = h.service.edit(created.id, { message: 'Continue', trigger: 'available', turnLimit: 5, stopPhrase: 'ALL DONE' });
  assert.equal(set.chain.stopPhrase, 'ALL DONE');
  // An editor that does not know the field keeps the saved phrase.
  assert.equal(h.service.edit(created.id, { message: 'Keep going', trigger: 'available', turnLimit: 4 }).chain.stopPhrase, 'ALL DONE');
  assert.equal(h.service.edit(created.id, { message: 'Keep going' }).chain.stopPhrase, 'ALL DONE');
  assert.equal(h.view(created.id).automation.stopPhrase, 'ALL DONE');
  assert.throws(() => h.service.edit(created.id, { message: 'Keep going', trigger: 'available', turnLimit: 1, stopPhrase: 'ALL DONE' }), /only applies when more than one turn/);
  assert.equal(h.service.edit(created.id, { message: 'Keep going', trigger: 'available', turnLimit: 1 }).chain.stopPhrase, null, 'A single turn drops a kept phrase');
  assert.equal(h.service.edit(created.id, { message: 'Keep going', trigger: 'available', continuous: true, stopPhrase: 'FINISHED' }).chain.stopPhrase, 'FINISHED');
  assert.equal(h.service.edit(created.id, { message: 'Keep going', trigger: 'available', continuous: true, stopPhrase: null }).chain.stopPhrase, null);
  h.service.edit(created.id, { message: 'Keep going', trigger: 'available', continuous: true, stopPhrase: 'FINISHED' });
  h.service.stop(created.id);
  assert.equal(h.service.scheduleAgain(created.id).stopPhrase, 'FINISHED');
});

test('T3 Code reports the last assistant message of the turn from the thread', () => {
  const requestedAt = '2026-10-01T10:00:00.000Z';
  const turn = { deliveryKey: 'message-1', turnId: `requested:${requestedAt}` };
  const messages = [
    { id: 'm-user', role: 'user', text: 'Continue', turnId: null, streaming: false },
    { id: 'm-1', role: 'assistant', text: 'Working on it', turnId: 'turn-9', streaming: false },
    { id: 'm-2', role: 'assistant', text: 'Done. TASK COMPLETE', turnId: 'turn-9', streaming: false },
    { id: 'm-other', role: 'assistant', text: 'Another turn', turnId: 'turn-8', streaming: false }
  ];
  const latest = { turnId: 'turn-9', state: 'completed', requestedAt, completedAt: '2026-10-01T10:05:00.000Z', assistantMessageId: 'm-2' };
  const now = Date.parse('2026-10-01T10:06:00Z');
  assert.equal(turnOutcomeFor({ messages, latestTurn: latest }, turn, now).lastAgentMessage, 'Done. TASK COMPLETE', 'latestTurn.assistantMessageId names it');
  assert.equal(lastAgentMessage({ messages }, { ...latest, assistantMessageId: null }), 'Done. TASK COMPLETE', 'Otherwise the newest assistant message of the turn');
  assert.equal(lastAgentMessage({ messages: [...messages.slice(0, 2), { ...messages[2], streaming: true }] }, { ...latest, assistantMessageId: 'm-2' }), 'Working on it', 'A streaming message is not final');
  assert.equal(lastAgentMessage({ messages: [] }, latest), null);
  assert.equal(turnOutcomeFor({ messages, latestTurn: { ...latest, state: 'running' } }, turn, now).lastAgentMessage, undefined);
});

test('a T3 Code continuation finishes on the stop phrase through polling', async () => {
  let thread = { id: 'thread', title: 'T3 thread', projectId: 'p', messages: [], activities: [], modelSelection: { model: 'm', instanceId: 'i' }, runtimeMode: 'full-access', interactionMode: 'default', latestTurn: null };
  const commands = [];
  const api = { fetchThread: async () => thread, fetchSnapshot: async () => ({ threads: [thread], projects: [] }), dispatch: async (command) => { commands.push(command); return { sequence: commands.length }; } };
  let clock = Date.now() + 60_000;
  const timers = [];
  const service = new JobService({ harnesses: createHarnessRegistry([createT3Harness({ api, now: () => clock })]), now: () => clock, persist: () => {}, scheduleTimer: (date, callback) => { timers.push({ date, callback }); return { cancel() {} }; } });
  const job = await service.create({ harness: 't3', threadId: 'thread', message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC', continuous: true, stopPhrase: 'TASK COMPLETE' });
  const finishTurn = async (n, text) => {
    const at = new Date(clock).toISOString();
    thread = { ...thread, messages: [...thread.messages, { id: `reply-${n}`, role: 'assistant', text, turnId: `turn-${n}`, streaming: false, createdAt: at, updatedAt: at }],
      latestTurn: { turnId: `turn-${n}`, state: 'completed', requestedAt: commands[n - 1].createdAt, startedAt: commands[n - 1].createdAt, completedAt: at, assistantMessageId: `reply-${n}` } };
    await service.pollTurns();
  };
  clock += 120_000;
  await service.run(job.id);
  clock += 120_000;
  await finishTurn(1, 'Halfway there.');
  clock += 10_000;
  await service.run(job.id);
  assert.equal(commands.length, 2);
  clock += 120_000;
  await finishTurn(2, 'Everything is done.\nTASK COMPLETE');
  const done = service.present(service.get(job.id));
  assert.deepEqual([done.automation.state, done.automation.reasonCode, done.automation.sentTurns], ['finished', 'stop_phrase', 2]);
  clock += 10 * 60_000;
  await service.run(job.id);
  assert.equal(commands.length, 2);
});

test('the stop phrase alone can be set, changed or removed on a running or paused continuation', async () => {
  const h = serviceFixture();
  const created = await chain(h, { stopPhrase: undefined, continuous: true });
  await h.advance(5_000);
  await h.finish(1, { lastAgentMessage: 'TASK COMPLETE' });
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2, 'Without a phrase the chain carried on');
  // Turn 2 is running: other edits are refused, but the phrase alone may change.
  assert.throws(() => h.service.edit(created.id, { message: 'Keep going' }), { code: 'invalid_state' });
  const set = h.service.edit(created.id, { stopPhrase: '  task   complete ' });
  assert.deepEqual([set.automation.stopPhrase, set.automation.state, set.turn.state, set.messageId], ['task complete', 'active', 'running', h.get(created.id).messageId]);
  assert.equal(h.armedTimers().length, 0, 'Nothing is rescheduled or sent by the edit');
  await h.finish(2, { lastAgentMessage: 'Done. Task complete.' });
  const finished = h.view(created.id);
  assert.deepEqual([finished.automation.state, finished.automation.reasonCode], ['finished', 'stop_phrase']);
  assert.throws(() => h.service.edit(created.id, { stopPhrase: 'DONE' }), (error) => error.code === 'invalid_state' && /already ended/.test(error.message));
});

test('a phrase-only edit on a paused continuation can remove the phrase, and is checked like any other', async () => {
  const h = serviceFixture();
  const created = await chain(h);
  await h.advance(5_000);
  const job = h.get(created.id);
  h.service.patch(job, h.service.chainPatch(job, 'paused', 'turn_failed', 'The last turn failed.'));
  assert.equal(h.service.edit(created.id, { stopPhrase: null }).automation.stopPhrase, null);
  assert.equal(h.service.edit(created.id, { stopPhrase: 'FINISHED' }).automation.stopPhrase, 'FINISHED');
  assert.throws(() => h.service.edit(created.id, { stopPhrase: 'no' }), /between 3 and 200/);
  const single = await h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 1 });
  assert.throws(() => h.service.edit(single.id, { stopPhrase: 'DONE' }), /only applies when more than one turn/);
  const blind = serviceFixture({ capabilities: { canReportAgentMessage: false } });
  const plain = await chain(blind, { stopPhrase: undefined });
  assert.throws(() => blind.service.edit(plain.id, { stopPhrase: 'DONE' }), /does not report the agent's last message/);
  assert.equal(blind.service.edit(plain.id, { stopPhrase: null }).automation.stopPhrase, null);
});

test('the window offers exactly the edits the service accepts, and its stop phrase edit changes nothing else', async () => {
  const h = serviceFixture();
  const scope = (id) => compose.editScope(h.view(id), { stopPhrase: true });
  const created = await chain(h, { message: 'Keep going', turnLimit: 4 });
  assert.equal(scope(created.id), 'all', 'Before the first turn every setting can change');
  await h.advance(5_000);
  await h.finish(1, { lastAgentMessage: 'Still working.' });
  await h.advance(5_000);
  assert.equal(scope(created.id), 'stopPhrase', 'Turn 2 is running');
  const before = h.view(created.id);
  // The full edit the composer would otherwise send is refused once a turn has been sent.
  assert.throws(() => h.service.edit(created.id, { message: 'Keep going', trigger: 'available', turnLimit: 4, stopPhrase: 'ALL DONE' }), { code: 'invalid_state' });
  const draft = { far: 'upto', turnLimit: '9', message: 'Changed', when: '5', stopPhrase: ' all   done ', editScope: 'stopPhrase' };
  const after = h.service.edit(created.id, compose.stopPhraseEdit(draft));
  assert.equal(after.automation.stopPhrase, 'all done');
  assert.deepEqual([after.message, after.trigger, after.automation.limit, after.scheduleAt, after.messageId, after.turn.state], [before.message, before.trigger, before.automation.limit, before.scheduleAt, before.messageId, 'running']);
  const job = h.get(created.id);
  h.service.patch(job, h.service.chainPatch(job, 'paused', 'turn_failed', 'The last turn failed.'));
  assert.equal(scope(created.id), 'stopPhrase', 'A paused continuation can still change its phrase');
  assert.equal(h.service.edit(created.id, compose.stopPhraseEdit({ ...draft, stopPhrase: '' })).automation.stopPhrase, null);
  h.service.stop(created.id);
  assert.equal(scope(created.id), null, 'An ended continuation offers no edit');
  const single = await h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 1 });
  await h.advance(5_000);
  assert.equal(scope(single.id), null, 'A single-turn continuation has no phrase to change');
});
