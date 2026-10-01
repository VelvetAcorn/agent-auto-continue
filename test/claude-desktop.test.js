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
  // Claude Code 2.1.286 writes { pid, sessionId, startedAt, kind, entrypoint } at startup and adds `status` with its first update.
  const live = (status, entrypoint = 'claude-desktop', extra = {}) => fs.writeFileSync(path.join(home, '.claude', 'sessions', '13299.json'),
    JSON.stringify({ pid: 13299, sessionId: CLI, startedAt: START - 3_600_000, kind: 'interactive', entrypoint, hostSessionId: SESSION, status, ...extra }));
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

test('checkConnection skips the ioreg lock helper but reports the lock state, permission and a stopped app from Accessibility', async (t) => {
  const { adapter, fake } = setup(t, { locked: true });
  assert.deepEqual(await adapter.checkConnection(), { ok: true, version: '1.0' }, 'The shared ioreg helper is not consulted');
  // On a real Mac the Accessibility environment reports the lock too, and then the check fails.
  fake.state.screenLocked = true;
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'screen_locked' && error.deliveryUncertain === false);
  fake.state.screenLocked = false;
  fake.state.trusted = false;
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'permission_required' && error.details.settingsUrl.includes('Privacy_Accessibility'));
  fake.state.trusted = true;
  fake.state.running = false;
  await assert.rejects(adapter.checkConnection(), (error) => error.code === 'connection_refused');
});

test('localised labels are read from the catalogue inside the app wherever it is installed', async (t) => {
  const { fixture, advance } = setup(t);
  const bundle = path.join(fixture.home, 'Elsewhere', 'Claude.app');
  const catalogue = path.join(bundle, 'Contents', 'Resources', 'ion-dist', 'i18n');
  fs.mkdirSync(catalogue, { recursive: true });
  fs.writeFileSync(path.join(catalogue, 'de-DE.json'), JSON.stringify({ iWKE8shLIt: 'Eingabe', '9WRlF4R2gm': 'Senden' }));
  let clock = START;
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { urlSegment: SESSION, language: 'de-DE', composerLabel: 'Eingabe', sendLabel: 'Senden' },
    onSend: (text) => fixture.append({ type: 'user', uuid: 'sent-de', timestamp: new Date(clock).toISOString(), message: { role: 'user', content: text } }) });
  fake.state.installedPath = bundle;
  const adapter = createClaudeDesktopHarness({ home: fixture.home, env: {}, isAlive: () => false, automation: fake.automation, isLocked: async () => false, platform: 'darwin',
    now: () => clock, sleep: async (ms) => { clock += ms; advance(ms); }, timings: { navigateMs: 1000, confirmMs: 1000, pollMs: 250 } });
  assert.deepEqual(await adapter.submitTurn(turn(), { sessionId: SESSION }), { turnId: 'sent-de' });
});

test('the stop button near the message box is a second busy signal, independent of the registry', async (t) => {
  // The registry says nothing is running, as it would if an update moved it.
  const { adapter, fake } = setup(t);
  fake.state.view = { ...fake.state.view, urlSegment: SESSION, stop: true, stopLabel: 'Stop response' };
  await assert.rejects(adapter.submitTurn(turn(), { sessionId: SESSION }), (error) => error.code === 'conversation_busy' && error.deliveryUncertain === false);
  assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0, 'Nothing typed');
  const target = fake.state.calls.find((call) => call[0] === 'inspect')[1];
  assert.deepEqual(target.stopLabels, ['Stop response'], 'Both catalogue IDs read "Stop response" in English');
});

test('the stop button is recognised in the interface language from the catalogue', async (t) => {
  const { fixture } = setup(t);
  const bundle = path.join(fixture.home, 'Claude.app');
  const catalogue = path.join(bundle, 'Contents', 'Resources', 'ion-dist', 'i18n');
  fs.mkdirSync(catalogue, { recursive: true });
  fs.writeFileSync(path.join(catalogue, 'de-DE.json'), JSON.stringify({ iWKE8shLIt: 'Eingabe', '9WRlF4R2gm': 'Senden', '9PawskFnw4': 'Antwort stoppen' }));
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { urlSegment: SESSION, language: 'de-DE', composerLabel: 'Eingabe', sendLabel: 'Senden', stop: true, stopLabel: 'Antwort stoppen' } });
  fake.state.installedPath = bundle;
  let clock = START;
  const adapter = createClaudeDesktopHarness({ home: fixture.home, env: {}, isAlive: () => false, automation: fake.automation, isLocked: async () => false, platform: 'darwin',
    now: () => clock, sleep: async (ms) => { clock += ms; }, timings: { navigateMs: 1000, confirmMs: 1000, pollMs: 250 } });
  await assert.rejects(adapter.submitTurn(turn(), { sessionId: SESSION }), (error) => error.code === 'conversation_busy');
  assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0);
});

const transcriptDrift = (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'transcript' && error.deliveryUncertain === false;

test('a transcript in an unfamiliar format refuses before sending instead of silently losing the activity check', async (t) => {
  const formats = [
    ['renamed record types', (at) => ({ type: 'prompt', uuid: 'n1', timestamp: at, message: { role: 'user', content: 'I am back' } })],
    ['renamed timestamps', (at) => ({ type: 'user', uuid: 'n1', time: at, message: { role: 'user', content: 'I am back' } })]
  ];
  for (const [label, record] of formats) {
    const { adapter, fake, fixture } = setup(t);
    const transcript = path.join(fixture.home, '.claude', 'projects', '-work-FeedWorks-io', `${CLI}.jsonl`);
    fs.writeFileSync(transcript, '');
    for (let i = 0; i < 3; i++) fixture.append(record(new Date(START + i).toISOString()));
    const state = await adapter.inspectConversation({ conversationId: SESSION });
    assert.throws(() => adapter.prepareTurn(turn(), state), (error) => transcriptDrift(error)
      && error.message === 'Claude Desktop 1.0 changed how it records conversations, so Agent Auto-Continue cannot work with it until it supports this version.', label);
    assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0);
  }
});

test('records in a new format after an update are noticed even when older records are familiar', async (t) => {
  const { adapter, fixture } = setup(t);
  fixture.append({ type: 'prompt', uuid: 'n1', timestamp: new Date(START).toISOString(), message: { role: 'user', content: 'I am back' } });
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => transcriptDrift(error) && /unknown record type "prompt"/.test(error.details.hint));
});

test('a new or quiet transcript with no messages yet is not mistaken for a format change', async (t) => {
  const { adapter, fixture } = setup(t);
  const transcript = path.join(fixture.home, '.claude', 'projects', '-work-FeedWorks-io', `${CLI}.jsonl`);
  // The shape of real sessions that were opened without a prompt: settings, attachments and bookkeeping only.
  fs.writeFileSync(transcript, '');
  for (const type of ['mode', 'permission-mode', 'bridge-session', 'attachment', 'attachment', 'attachment', 'system', 'bridge-session', 'cost-state', 'last-prompt', 'cost-state']) {
    fixture.append({ type, sessionId: CLI, timestamp: new Date(START).toISOString() });
  }
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.equal(state.context.drift, null);
  assert.deepEqual(adapter.prepareTurn(turn(), state).plan, { sessionId: SESSION });
});

test('end to end: user activity in a changed transcript format fails the job instead of sending over it', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(30_000);
  // Claude Desktop updates and records the user's new prompt in a format this version does not know.
  fixture.append({ type: 'human', uuid: 'typed', timestamp: new Date(now()).toISOString(), message: { role: 'user', content: 'I am back' } });
  advance(90_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.error?.code, failed.error?.details.contactPoint], ['failed', 'app_version_unsupported', 'transcript']);
  assert.equal(fake.state.sent.length, 0);
});

const storeDrift = (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'session_store' && error.deliveryUncertain === false;
const storeDir = (fixture) => path.join(fixture.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
// Rewrites every session file through `change`, as an update that renamed fields would.
function rewriteStore(fixture, change) {
  const index = path.join(storeDir(fixture), 'account', 'org');
  for (const name of fs.readdirSync(index)) fs.writeFileSync(path.join(index, name), JSON.stringify(change(JSON.parse(fs.readFileSync(path.join(index, name), 'utf8')))));
}

test('session files that no longer parse into sessions are a store change, not an empty list', async (t) => {
  const { adapter, fixture } = setup(t);
  rewriteStore(fixture, ({ cliSessionId, ...rest }) => ({ ...rest, cliSessionID: cliSessionId }));
  await assert.rejects(adapter.listConversations({}), (error) => storeDrift(error)
    && error.message === 'Claude Desktop 1.0 changed how it stores its sessions, so Agent Auto-Continue cannot work with it until it supports this version.'
    && /3 of 3 session files/.test(error.details.hint));
  await assert.rejects(adapter.inspectConversation({ conversationId: SESSION }), storeDrift, 'A scheduled session is not reported as gone');
});

test('a clear majority of unreadable session files is a store change, but one odd or brand-new file is not', async (t) => {
  const { adapter, fixture } = setup(t);
  const index = path.join(storeDir(fixture), 'account', 'org');
  // A session created moments ago may not have its Claude Code session yet.
  fs.writeFileSync(path.join(index, 'local_22222222-2222-4333-8444-555555555555.json'), JSON.stringify({ sessionId: 'local_22222222-2222-4333-8444-555555555555', cwd: fixture.work, title: 'New' }));
  fs.writeFileSync(path.join(index, 'local_33333333-2222-4333-8444-555555555555.json'), '[]');
  assert.equal((await adapter.listConversations({})).length, 2, 'One odd file among readable ones is skipped');
  for (const n of [4, 5, 6, 7]) fs.writeFileSync(path.join(index, `local_${n}${n}${n}${n}${n}${n}${n}${n}-2222-4333-8444-555555555555.json`), JSON.stringify({ id: 'x' }));
  await assert.rejects(adapter.listConversations({}), storeDrift);
});

test('session files that moved to another folder depth are a store change', async (t) => {
  const { adapter, fixture } = setup(t);
  const deeper = path.join(storeDir(fixture), 'account', 'org', 'workspace');
  fs.mkdirSync(deeper);
  const index = path.join(storeDir(fixture), 'account', 'org');
  for (const name of fs.readdirSync(index).filter((item) => item.endsWith('.json'))) fs.renameSync(path.join(index, name), path.join(deeper, name));
  await assert.rejects(adapter.listConversations({}), (error) => storeDrift(error) && /unexpected folder depth/.test(error.details.hint));
});

test('no session store means no Code sessions when listing, but a scheduled session is not silently canceled', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  fs.rmSync(storeDir(fixture), { recursive: true });
  assert.deepEqual(await adapter.listConversations({}), []);
  advance(120_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.error?.code, failed.error?.details.contactPoint], ['failed', 'app_version_unsupported', 'session_store']);
  assert.equal(fake.state.sent.length, 0);
});

test('end to end: a session store change fails the job instead of canceling it as gone', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  rewriteStore(fixture, ({ sessionId, ...rest }) => ({ ...rest, id: sessionId }));
  advance(120_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.error?.code, failed.error?.details.contactPoint], ['failed', 'app_version_unsupported', 'session_store']);
  assert.equal(fake.state.sent.length, 0);
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

test('end to end: a Claude Desktop update that renames the message box fails the job clearly and sends nothing', async (t) => {
  const { adapter, fake, now, advance } = setup(t);
  fake.state.version = '2.17.0';
  fake.state.view.composerLabel = 'Message Claude';
  const { service, notifications } = jobService(adapter, now);
  const job = await schedule(service, now);
  advance(120_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.deliveryCertainty, failed.error.code], ['failed', 'not-delivered', 'app_version_unsupported']);
  assert.equal(failed.note, 'Claude Desktop 2.17.0 changed how its message box is labelled, so Agent Auto-Continue could not send. Nothing was sent.');
  assert.deepEqual([failed.error.details.appVersion, failed.error.details.verifiedVersion, failed.error.details.contactPoint], ['2.17.0', '2.16120.0', 'composer_label']);
  assert.equal(notifications.at(-1)[1], failed.note);
  assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0);
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

test('a live process that does not identify itself as Claude Desktop is never treated as the app', async (t) => {
  const { adapter, fixture } = setup(t);
  // An older or unknown Claude Code process may omit its entrypoint; it could still be a second writer.
  fixture.live('idle', null);
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.equal(state.context.elsewhere, true);
  assert.throws(() => adapter.prepareTurn(turn(), state), /outside Claude Desktop/);
  assert.equal((await adapter.listConversations({})).find((item) => item.id === SESSION).state, 'open elsewhere');
});

test('the check right before typing refuses a session that is waiting for an answer or open elsewhere', async (t) => {
  for (const [status, entrypoint, code] of [['waiting', 'claude-desktop', 'awaiting_input'], ['blocked', 'claude-desktop', 'awaiting_input'], ['idle', 'cli', 'conversation_busy'], ['idle', null, 'conversation_busy']]) {
    const { adapter, fake, fixture } = setup(t);
    // The state changed after prepareTurn ran.
    fixture.live(status, entrypoint);
    await assert.rejects(adapter.submitTurn(turn(), { sessionId: SESSION }), (error) => error.code === code && error.deliveryUncertain === false, `${status} ${entrypoint}`);
    assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0, `${status} ${entrypoint}: nothing typed`);
  }
});

test('busy and awaiting input come only from the live status, so the job service and prepareTurn give the right reason', async (t) => {
  const { adapter, fixture } = setup(t);
  fixture.live('idle', 'cli');
  let state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.deepEqual([state.busy, state.awaitingInput], [false, false], 'An idle terminal session is not reported as working');
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'conversation_busy' && /outside Claude Desktop/.test(error.message));
  fixture.live('waiting');
  state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'awaiting_input');
  fixture.live('shell');
  state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.deepEqual([state.busy, state.awaitingInput], [true, false], 'Claude Code shows a running shell command as working');
});

// Drift of the registry must never read as idle.
const registryDrift = (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'live_registry' && error.deliveryUncertain === false;

test('an unknown or missing live status refuses before typing, as a registry change', async (t) => {
  for (const [label, status, extra] of [['renamed status', 'running', {}], ['missing status', undefined, {}], ['non-text status', 3, {}]]) {
    const { adapter, fake, fixture } = setup(t);
    fixture.live(status, 'claude-desktop', extra);
    const state = await adapter.inspectConversation({ conversationId: SESSION });
    assert.deepEqual([state.busy, state.awaitingInput], [null, null], label);
    assert.throws(() => adapter.prepareTurn(turn(), state), (error) => registryDrift(error)
      && error.message === 'Claude Desktop 1.0 changed how it reports whether the agent is working, so Agent Auto-Continue could not send. Nothing was sent.', label);
    assert.equal(state.context.drift.contactPoint, 'live_registry');
    await assert.rejects(adapter.submitTurn(turn(), { sessionId: SESSION }), registryDrift, `${label}: the check right before typing refuses too`);
    assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0, `${label}: nothing typed`);
    assert.equal((await adapter.listConversations({})).find((item) => item.id === SESSION).state, 'unknown');
  }
  const { adapter, fixture } = setup(t);
  fixture.live('running');
  assert.match((await adapter.inspectConversation({ conversationId: SESSION })).context.drift.hint, /unknown status "running"/);
});

test('a process that has only just started may not report a status yet, and counts as working', async (t) => {
  const { adapter, fixture } = setup(t);
  fixture.live(undefined, 'claude-desktop', { startedAt: START - 5_000 });
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.deepEqual([state.busy, state.awaitingInput, state.context.drift], [true, false, null]);
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => error.code === 'conversation_busy');
});

test('a live registry entry that names no session could be any session, so every send refuses', async (t) => {
  const { adapter, fake, fixture } = setup(t);
  // An update renames the session field: the entry can no longer be matched to its session.
  fs.writeFileSync(path.join(fixture.home, '.claude', 'sessions', '13299.json'), JSON.stringify({ pid: 13299, session_id: CLI, startedAt: START - 60_000, kind: 'interactive', entrypoint: 'claude-desktop', status: 'busy' }));
  const state = await adapter.inspectConversation({ conversationId: SESSION });
  assert.throws(() => adapter.prepareTurn(turn(), state), (error) => registryDrift(error) && /no session ID/.test(error.details.hint));
  await assert.rejects(adapter.submitTurn(turn(), { sessionId: SESSION }), registryDrift);
  assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0);
});

test('when several processes hold the session, the most restrictive entry wins', async (t) => {
  const { fixture } = setup(t);
  const write = (pid, status, entrypoint = 'claude-desktop') => fs.writeFileSync(path.join(fixture.home, '.claude', 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: CLI, startedAt: START - 60_000, kind: 'interactive', entrypoint, status }));
  const alive = new Set([13299, 13300]);
  const harness = createClaudeDesktopHarness({ home: fixture.home, env: {}, isAlive: (pid) => alive.has(pid), automation: createFakeDesktopAutomation({ bundleId: BUNDLE_ID }).automation,
    isLocked: async () => false, platform: 'darwin', now: () => START, appPath: null });
  write(13299, 'idle');
  write(13300, 'busy');
  assert.equal((await harness.inspectConversation({ conversationId: SESSION })).busy, true);
  write(13299, 'mystery');
  assert.equal((await harness.inspectConversation({ conversationId: SESSION })).context.drift.contactPoint, 'live_registry');
});

test('end to end: a Claude Code update that renames a live status fails the job clearly and types nothing', async (t) => {
  const { adapter, fake, fixture, now, advance } = setup(t);
  const { service } = jobService(adapter, now);
  const job = await schedule(service, now);
  fixture.live('running');
  advance(120_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.deliveryCertainty, failed.error.code, failed.error.details.contactPoint], ['failed', 'not-delivered', 'app_version_unsupported', 'live_registry']);
  assert.equal(fake.state.calls.filter((call) => call[0] === 'setComposer').length, 0);
});
