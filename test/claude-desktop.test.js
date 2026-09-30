'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createClaudeDesktopHarness, BUNDLE_ID } = require('../lib/harnesses/claude-desktop');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { JobService } = require('../lib/job-service');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const START = Date.parse('2026-10-01T09:00:00.000Z');
const SESSION = 'local_7de42224-49eb-4544-a87c-181a7de40229';
const CLI = '660279f3-a100-4809-91a0-dc5991157d17';
const NEWEST = 'local_11111111-2222-4333-8444-555555555555';
const ARCHIVED = 'local_99999999-2222-4333-8444-555555555555';

// A fixture home laid out like Claude Desktop and Claude Code write it.
function fixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-desktop-'));
  const desktop = path.join(home, 'Library', 'Application Support', 'Claude');
  const index = path.join(desktop, 'claude-code-sessions', 'account', 'org');
  const work = path.join(home, 'work');
  fs.mkdirSync(index, { recursive: true });
  fs.mkdirSync(path.join(work, 'FeedWorks.io'), { recursive: true });
  fs.mkdirSync(path.join(work, 'new'), { recursive: true });
  const writeSession = (value) => fs.writeFileSync(path.join(index, `${value.sessionId}.json`), JSON.stringify(value));
  writeSession({ sessionId: SESSION, cliSessionId: CLI, cwd: path.join(work, 'FeedWorks.io'), title: 'Plan review', isArchived: false, createdAt: '1789399011650', lastActivityAt: '1789399045112' });
  writeSession({ sessionId: NEWEST, cliSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cwd: path.join(work, 'new'), title: 'Newest', isArchived: false, createdAt: 1789500000000, lastActivityAt: 1789500000000 });
  writeSession({ sessionId: ARCHIVED, cliSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', cwd: path.join(work, 'old'), title: 'Old', isArchived: true, createdAt: 1, lastActivityAt: 2 });
  const projects = path.join(home, '.claude', 'projects', '-work-FeedWorks-io');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const transcript = path.join(projects, `${CLI}.jsonl`);
  const append = (record) => fs.appendFileSync(transcript, `${JSON.stringify(record)}\n`);
  append({ type: 'user', uuid: 'first', timestamp: '2026-09-14T15:16:54.495Z', message: { role: 'user', content: 'Review the plan' }, entrypoint: 'claude-desktop', sessionId: CLI });
  append({ type: 'assistant', uuid: 'reply', timestamp: '2026-09-14T15:17:30.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the plan.' }], stop_reason: 'end_turn' } });
  const live = (status, entrypoint = 'claude-desktop') => fs.writeFileSync(path.join(home, '.claude', 'sessions', '13299.json'), JSON.stringify({ pid: 13299, sessionId: CLI, entrypoint, hostSessionId: SESSION, status }));
  const usage = (samples) => fs.writeFileSync(path.join(desktop, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
  return { home, work, append, live, usage, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function setup(t, { locked = false } = {}) {
  let clock = START;
  const fixture = fixtureHome();
  t.after(fixture.cleanup);
  const fake = createFakeDesktopAutomation({
    bundleId: BUNDLE_ID,
    view: { urlSegment: 'epitaxy' },
    navigate: (url) => {
      const match = /session=([^&]+)/.exec(url);
      return match ? { urlSegment: decodeURIComponent(match[1]) } : null;
    },
    // Claude Desktop records the prompt in the session transcript when it is sent.
    onSend: (text) => fixture.append({ type: 'user', uuid: 'sent-uuid', timestamp: new Date(clock).toISOString(), message: { role: 'user', content: text }, entrypoint: 'claude-desktop', sessionId: CLI })
  });
  const adapter = createClaudeDesktopHarness({ home: fixture.home, env: {}, isAlive: (pid) => pid === 13299, automation: fake.automation, isLocked: async () => locked, platform: 'darwin',
    now: () => clock, sleep: async (ms) => { clock += ms; }, timings: { navigateMs: 3000, confirmMs: 3000, pollMs: 250 }, appPath: null });
  return { adapter, fake, fixture, advance: (ms) => { clock += ms; }, now: () => clock };
}
const turn = (overrides = {}) => ({ jobId: 'job', harness: 'claude-desktop', conversationId: SESSION, message: 'Continue', messageId: 'm-1', commandId: 'c-1', deliveryKey: 'm-1', createdAt: null, dispatchAttemptedAt: new Date(START).toISOString(), turnId: null, ...overrides });

test('capabilities describe a desktop app that needs the app, an unlocked screen and Accessibility', (t) => {
  const { adapter } = setup(t);
  assert.equal(adapter.kind, 'desktop-app');
  assert.equal(adapter.capabilities.requiresRunningApp, true);
  assert.equal(adapter.capabilities.requiresUnlockedScreen, true);
  assert.equal(adapter.capabilities.requiresAccessibilityPermission, true);
  assert.equal(adapter.capabilities.canReportResetTime, false);
});

test('lists unarchived Code sessions newest first with live status labels', async (t) => {
  const { adapter, fixture } = setup(t);
  fixture.live('busy');
  const list = await adapter.listConversations({});
  assert.deepEqual(list.map((item) => [item.id, item.state, item.projectName]), [[NEWEST, 'idle', 'new'], [SESSION, 'working', 'FeedWorks.io']]);
  assert.equal(list[1].updatedAt, new Date(1789399045112).toISOString());
});

test('inspect reports transcript activity and live busy and awaiting-input state', async (t) => {
  const { adapter, fixture } = setup(t);
  let result = await adapter.inspectConversation({ conversationId: SESSION, deliveryKey: null }, { purpose: 'schedule' });
  assert.equal(result.latestUserActivityAt, '2026-09-14T15:16:54.495Z');
  assert.deepEqual([result.busy, result.awaitingInput, result.delivered], [false, null, false], 'No loaded process: not busy, input state unknown');
  fixture.live('waiting');
  result = await adapter.inspectConversation({ conversationId: SESSION });
  assert.deepEqual([result.busy, result.awaitingInput], [false, true]);
  fixture.live('idle');
  result = await adapter.inspectConversation({ conversationId: SESSION });
  assert.deepEqual([result.busy, result.awaitingInput], [false, false]);
  await assert.rejects(adapter.inspectConversation({ conversationId: 'local_00000000-0000-4000-8000-000000000000' }), (error) => error.code === 'conversation_not_found');
  await assert.rejects(adapter.inspectConversation({ conversationId: '../../etc' }), (error) => error.code === 'conversation_not_found');
});

test('prepareTurn refuses sessions that cannot be continued safely, before anything is typed', async (t) => {
  const { adapter, fixture } = setup(t);
  const inspect = () => adapter.inspectConversation({ conversationId: SESSION });
  for (const [status, entrypoint, message] of [['busy', 'claude-desktop', /still working/], ['blocked', 'claude-desktop', /waiting for your answer/], ['idle', 'cli', /outside Claude Desktop/]]) {
    fixture.live(status, entrypoint);
    const state = await inspect();
    assert.throws(() => adapter.prepareTurn(turn(), state), message);
  }
  fixture.live('idle');
  const state = await inspect();
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, item: { ...state.context.item, cwd: '/gone' } } }), (error) => error.code === 'conversation_not_found');
  assert.throws(() => adapter.prepareTurn(turn(), { ...state, context: { ...state.context, hasTranscript: false } }), (error) => error.code === 'unsupported_response_shape');
  assert.deepEqual(adapter.prepareTurn(turn(), state), { deliveryKey: 'm-1', plan: { sessionId: SESSION } });
});

test('submitTurn opens the session by deep link, sends through the UI and confirms from the transcript', async (t) => {
  const { adapter, fake } = setup(t);
  const result = await adapter.submitTurn(turn(), { sessionId: SESSION });
  assert.deepEqual(result, { turnId: 'sent-uuid' });
  assert.deepEqual(fake.state.opened, [`claude://code/continue?session=${SESSION}`]);
  assert.equal(fake.state.sent[0].view.urlSegment, SESSION);
  assert.deepEqual(fake.state.frontmost, { bundleId: 'com.example.editor', pid: 777 }, 'The previous app is in front again');
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  assert.equal((await adapter.inspectConversation(turn())).delivered, true);
});

test('delivery evidence must be the same text written after the send attempt', async (t) => {
  const { adapter, fixture } = setup(t);
  fixture.append({ type: 'user', uuid: 'old', timestamp: '2026-09-30T10:00:00.000Z', message: { role: 'user', content: 'Continue' } });
  assert.equal((await adapter.findDelivery(turn())).delivered, false, 'An older identical prompt is not evidence');
  assert.equal((await adapter.findDelivery(turn({ dispatchAttemptedAt: null }))).delivered, false);
  fixture.append({ type: 'user', uuid: 'tool', timestamp: new Date(START + 1000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'Continue' }] } });
  assert.equal((await adapter.findDelivery(turn())).delivered, false, 'Tool results are not prompts');
  fixture.append({ type: 'user', uuid: 'new', timestamp: new Date(START + 1000).toISOString(), message: { role: 'user', content: 'Continue\n' } });
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
});

test('checkTurn reads the outcome after the confirmed prompt from the transcript', async (t) => {
  const { adapter, fixture, now } = setup(t);
  assert.deepEqual(await adapter.checkTurn(turn()), { state: 'unknown' }, 'Without a confirmed prompt there is no outcome');
  fixture.append({ type: 'user', uuid: 'sent-uuid', timestamp: new Date(now()).toISOString(), message: { role: 'user', content: 'Continue' } });
  fixture.live('busy');
  assert.equal((await adapter.checkTurn(turn({ turnId: 'sent-uuid' }))).state, 'running');
  fixture.append({ type: 'assistant', uuid: 'limit', timestamp: new Date(now() + 1000).toISOString(), isApiErrorMessage: true, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: 'You’ve hit your limit · resets 3pm (UTC)' }] } });
  const outcome = await adapter.checkTurn(turn({ turnId: 'sent-uuid' }));
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'usage_limited');
  assert.equal(outcome.usageLimit.resetsAt, '2026-10-01T15:00:00.000Z');
});

test('availability uses a fresh plan-usage sample and reports a locked screen as unavailable', async (t) => {
  const { adapter, fixture, now } = setup(t);
  assert.equal((await adapter.probeAvailability()).state, 'unknown');
  fixture.usage([{ t: now() - 60_000, org: 'org', u: { fh: 100, sd: 40 } }]);
  let available = await adapter.probeAvailability();
  assert.deepEqual([available.state, available.source, available.resetsAt], ['limited', 'inferred', null]);
  fixture.usage([{ t: now() - 60 * 60_000, org: 'org', u: { fh: 100, sd: 40 } }]);
  assert.equal((await adapter.probeAvailability()).state, 'unknown', 'Stale samples are ignored');
  fixture.usage([{ t: now(), org: 'org', u: { fh: 12, sd: 40 } }]);
  assert.equal((await adapter.probeAvailability()).state, 'available');
  const locked = setup(t, { locked: true });
  available = await locked.adapter.probeAvailability();
  assert.deepEqual([available.state, available.reason, available.source], ['unavailable', 'screen_locked', 'reported']);
});

test('checkConnection reports missing permission with the settings link and works while locked', async (t) => {
  const { adapter, fake } = setup(t, { locked: true });
  assert.deepEqual(await adapter.checkConnection(), { ok: true, version: '1.0' });
  fake.state.trusted = false;
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'permission_required' && error.details.settingsUrl.includes('Privacy_Accessibility'));
  fake.state.trusted = true;
  fake.state.running = false;
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'connection_refused');
});

test('off macOS the adapter lists nothing and refuses to send', async () => {
  const adapter = createClaudeDesktopHarness({ platform: 'linux', home: os.tmpdir() });
  assert.deepEqual(await adapter.listConversations({}), []);
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'harness_not_installed');
});

function jobService(adapter, clock) {
  const notifications = [];
  let n = 0;
  const service = new JobService({ harnesses: createHarnessRegistry([adapter]), now: clock, persist: () => {}, notify: (...args) => notifications.push(args), uuid: () => `id-${++n}` });
  return { service, notifications };
}
const schedule = (service, now) => service.create({ harness: 'claude-desktop', threadId: SESSION, message: 'Continue', whenISO: new Date(now() + 60_000).toISOString(), timeZone: 'UTC' });

test('end to end through the job service: sent, tracked and confirmed', async (t) => {
  const { adapter, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(120_000);
  await service.run(job.id);
  const sent = service.get(job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.deliveryCertainty, 'delivered');
  assert.deepEqual([sent.turn.state, sent.turn.turnId], ['running', 'sent-uuid']);
});

test('end to end: an unconfirmed UI send becomes unconfirmed and is reconciled from the transcript later', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  fake.state.faults.submit = () => ({ ok: true, pressed: true });
  const { service, notifications } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(120_000);
  await service.run(job.id);
  assert.equal(service.present(service.get(job.id)).deliveryStatus, 'unconfirmed');
  assert.equal(notifications.at(-1)[0], 'Delivery unconfirmed');
  fixture.append({ type: 'user', uuid: 'late', timestamp: new Date(now()).toISOString(), message: { role: 'user', content: 'Continue' } });
  assert.equal((await service.reconcile(job.id)).deliveryStatus, 'sent');
});

test('end to end: a locked screen fails the job without touching the app', async (t) => {
  const { adapter, fake, now, advance } = setup(t);
  fake.state.screenLocked = true;
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(120_000);
  await service.run(job.id);
  const failed = service.get(job.id);
  assert.deepEqual([failed.status, failed.deliveryCertainty, failed.error.code], ['failed', 'not-delivered', 'screen_locked']);
  assert.equal(fake.state.calls.filter((call) => call[0] !== 'environment').length, 0);
});

test('end to end: user activity after scheduling cancels the send', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(30_000);
  fixture.append({ type: 'user', uuid: 'typed', timestamp: new Date(now()).toISOString(), message: { role: 'user', content: 'I am back' } });
  advance(90_000);
  await service.run(job.id);
  assert.equal(service.get(job.id).status, 'canceled');
  assert.equal(fake.state.sent.length, 0);
});
