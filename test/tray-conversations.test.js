'use strict';
// The menu-bar tray lists recent conversations from every connected harness, from a cache
// that refreshes in the background, so opening the menu never waits for a harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const { defineHarness } = require('../lib/harnesses/contract');
const { HarnessError } = require('../lib/harnesses/errors');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { LIST_TIMEOUT_MS, PER_HARNESS_LIMIT, REFRESH_TTL_MS, connectionLabel, conversationMenuItems, createConversationCache } = require('../lib/tray-conversations');
const { createFakeHarness } = require('../tools/fake-harness.cjs');
const { appHarness } = require('./app-harness');

// main.js runs in its own VM context, so its values are compared as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 8, minutes)).toISOString();

// An adapter whose listing the test controls: a list, an error, or a promise that never settles.
function listing(id, label, answer, { discover = true } = {}) {
  const { adapter } = createFakeHarness({ id, label, capabilities: { canDiscoverConversations: discover } });
  const calls = [];
  const wrapped = defineHarness({ ...adapter, async listConversations(options) { calls.push(options); const value = typeof answer === 'function' ? answer() : answer; if (value instanceof Error) throw value; return value; } });
  return { adapter: wrapped, calls };
}
const conversation = (id, minutes, extra = {}) => ({ id, title: `Conversation ${id}`, projectName: 'repo', updatedAt: at(minutes), settled: null, ...extra });

function cacheFor(adapters, options = {}) {
  let clock = Date.parse('2026-10-01T08:00:00Z');
  const timers = [];
  let changes = 0;
  const cache = createConversationCache({ harnesses: createHarnessRegistry(adapters.map((item) => item.adapter)), now: () => clock, onChange: () => { changes++; },
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms, cleared: false }; timers.push(timer); return timer; }, clearTimer: (timer) => { if (timer) timer.cleared = true; }, ...options });
  return { cache, advance: (ms) => { clock += ms; for (const timer of timers.filter((item) => !item.cleared && item.at <= clock)) { timer.cleared = true; timer.fn(); } }, get changes() { return changes; } };
}

test('groups conversations by harness in registry order, newest first, capped, skipping disconnected, unconfigured, empty and settled', async () => {
  const many = Array.from({ length: PER_HARNESS_LIMIT + 3 }, (_, index) => conversation(`oc-${index}`, index));
  const t3 = listing('t3', 'T3 Code', [conversation('t-old', 1), conversation('t-new', 30), conversation('t-settled', 40, { settled: true })]);
  const opencode = listing('opencode', 'OpenCode', many);
  const offline = listing('codex', 'Codex', new HarnessError('connection_refused', 'Codex is not running.'));
  const unconfigured = listing('claude-code', 'Claude Code', new HarnessError('harness_not_installed', 'Claude Code was not found.'));
  const empty = listing('claude-desktop', 'Claude Desktop', []);
  const blind = listing('blind', 'No listing', [conversation('never', 1)], { discover: false });
  const { cache } = cacheFor([t3, opencode, offline, unconfigured, empty, blind]);
  assert.deepEqual(cache.snapshot(), { groups: [], loading: true }, 'Nothing is read before a refresh');
  assert.equal(connectionLabel(cache.snapshot()), 'Looking for conversations…');
  await cache.refresh();
  const { groups, loading } = cache.snapshot();
  assert.equal(loading, false);
  assert.deepEqual(groups.map((group) => [group.harness, group.label, group.total]), [['t3', 'T3 Code', 2], ['opencode', 'OpenCode', PER_HARNESS_LIMIT + 3]]);
  assert.deepEqual(groups[0].conversations.map((item) => item.id), ['t-new', 't-old']);
  assert.equal(groups[1].conversations.length, PER_HARNESS_LIMIT);
  assert.equal(groups[1].conversations[0].id, `oc-${PER_HARNESS_LIMIT + 2}`, 'Newest activity first');
  assert.equal(blind.calls.length, 0, 'Harnesses that cannot list conversations are never asked');
  assert.deepEqual(t3.calls, [{ showSettled: false }]);
  assert.equal(connectionLabel(cache.snapshot()), 'Conversations from T3 Code, OpenCode');
});

test('a refresh reuses cached results for five minutes unless forced, so CLIs are not started on every menu open', async () => {
  const codex = listing('codex', 'Codex', [conversation('c-1', 1)]);
  const { cache, advance } = cacheFor([codex]);
  await cache.refresh();
  await cache.refresh();
  await cache.refresh();
  assert.equal(codex.calls.length, 1);
  advance(REFRESH_TTL_MS - 1);
  await cache.refresh();
  assert.equal(codex.calls.length, 1);
  advance(1);
  await cache.refresh();
  assert.equal(codex.calls.length, 2);
  await cache.refresh({ force: true });
  assert.equal(codex.calls.length, 3);
});

test('a harness that never answers is skipped after the timeout without holding up the others', async () => {
  const slow = listing('opencode', 'OpenCode', () => new Promise(() => {}));
  const fast = listing('t3', 'T3 Code', [conversation('t-1', 1)]);
  const { cache, advance } = cacheFor([fast, slow]);
  const refreshing = cache.refresh();
  await settle();
  assert.deepEqual(cache.snapshot().groups.map((group) => group.harness), ['t3'], 'The menu shows what has arrived');
  assert.equal(cache.snapshot().loading, true);
  advance(LIST_TIMEOUT_MS);
  await refreshing;
  assert.deepEqual(cache.snapshot(), { groups: [cache.snapshot().groups[0]], loading: false });
  // A refresh that is still running is shared rather than started again.
  const again = listing('codex', 'Codex', () => new Promise(() => {}));
  const second = cacheFor([again]);
  void second.cache.refresh();
  void second.cache.refresh();
  await settle();
  assert.equal(again.calls.length, 1);
});

test('the menu is rebuilt only when what it shows changes, and a forced refresh during a refresh runs again', async () => {
  let answer = [conversation('a', 1)];
  const harness = listing('t3', 'T3 Code', () => answer);
  const view = cacheFor([harness]);
  await view.cache.refresh();
  assert.equal(view.changes, 1);
  await view.cache.refresh({ force: true });
  assert.equal(view.changes, 1, 'Same conversations, no rebuild');
  answer = [conversation('a', 1), conversation('b', 2)];
  const first = view.cache.refresh({ force: true });
  void view.cache.refresh({ force: true });
  await first;
  await settle();
  assert.equal(harness.calls.length, 4, 'The forced refresh queued behind the running one');
  assert.equal(view.changes, 2);
  answer = new HarnessError('connection_refused', 'Stopped.');
  await view.cache.refresh({ force: true });
  assert.deepEqual(view.cache.snapshot().groups, [], 'A harness that disconnects leaves the menu');
  assert.equal(view.changes, 3);
});

test('menu items have a heading per harness, schedule with the right harness, and show how many more there are', () => {
  const scheduled = [];
  let shown = 0;
  const groups = [
    { harness: 't3', label: 'T3 Code', noun: 'thread', total: 2, conversations: [conversation('t-1', 2, { title: 'A very long thread title that keeps going and going well past the menu width' }), conversation('t-2', 1, { title: '', projectName: '', projectId: 'p-2' })] },
    { harness: 'opencode', label: 'OpenCode', noun: 'session', total: 12, conversations: [conversation('o-1', 3)] }
  ];
  const items = conversationMenuItems({ groups, loading: false }, { schedule: (item) => scheduled.push(item), showAll: () => { shown++; } });
  assert.deepEqual(items.map((item) => item.type === 'separator' ? '---' : item.label), [
    'T3 Code', 'A very long thread title that keeps going and going well pa…', '(Untitled)', '---', 'OpenCode', 'Conversation o-1', '11 more sessions in the window', '---', 'Show all conversations…'
  ]);
  assert.deepEqual([items[0].enabled, items[6].enabled], [false, false]);
  assert.deepEqual([items[1].sublabel, items[2].sublabel], ['repo', 'p-2']);
  items[5].click();
  items[2].click();
  assert.deepEqual(scheduled.map((item) => [item.harness, item.id, item.title]), [['opencode', 'o-1', 'Conversation o-1'], ['t3', 't-2', '(Untitled)']]);
  items.at(-1).click();
  assert.equal(shown, 1);
  assert.deepEqual(conversationMenuItems({ groups: [], loading: true }, { schedule() {}, showAll() {} }).map((item) => item.label), ['Looking for conversations…', 'Show all conversations…']);
  assert.match(conversationMenuItems({ groups: [], loading: false }, { schedule() {}, showAll() {} })[0].label, /No connected agent has conversations/);
});

test('end to end in the main process: the tray lists two harnesses from the cache and schedules with the chosen one', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation', projectName: 'fake-repo', updatedAt: at(5) }] });
  let fakeLists = 0;
  const counted = defineHarness({ ...fake.adapter, async listConversations(options) { fakeLists++; return fake.adapter.listConversations(options); } });
  const broken = defineHarness({ ...createFakeHarness({ id: 'broken', label: 'Broken Agent' }).adapter, async listConversations() { throw new HarnessError('connection_refused', 'Broken Agent is not running.'); } });
  const app = appHarness([], { extraHarnesses: () => [counted, broken] });
  await settle();
  const submenu = () => app.trayMenu.find((item) => item.label === 'Schedule from a conversation').submenu;
  const status = () => app.trayMenu[1].label;
  // T3 Code answered the launch refresh with an error page, so only the fake harness is listed.
  assert.deepEqual(plain(submenu().filter((item) => item.enabled === false).map((item) => item.label)), ['Fake Agent']);
  assert.equal(status(), 'Conversations from Fake Agent');
  app.setResponse(async (url) => new Response(JSON.stringify(url.includes('/threads/') ? { thread: { id: 'thread-1', title: 'Parser rewrite', projectId: 'p', messages: [] } } :
    { threads: [{ id: 'thread-1', title: 'Parser rewrite', projectId: 'p', updatedAt: at(9), settledOverride: null }], projects: [{ id: 'p', title: 'Parser' }] }), { headers: { 'content-type': 'application/json' } }));
  app.trayMenu.find((item) => item.label === 'Refresh conversations').click();
  await settle();
  const labels = plain(submenu().map((item) => item.type === 'separator' ? '---' : item.label));
  assert.deepEqual(labels, ['T3 Code', 'Parser rewrite', '---', 'Fake Agent', 'Fake conversation', '---', 'Show all conversations…']);
  assert.equal(status(), 'Conversations from T3 Code, Fake Agent');
  assert.ok(!labels.includes('Broken Agent'), 'A disconnected harness is skipped');
  // Choosing a conversation opens the composer for its own harness.
  app.windows[0].finishLoad();
  submenu().find((item) => item.label === 'Fake conversation').click();
  assert.deepEqual(plain(app.events.filter(([name]) => name === 'app:navigate').at(-1)[1]), { view: 'composer', threadId: 'conv-1', threadLabel: 'Fake conversation', harness: 'fake' });
  // Schedule changes rebuild the menu from the cache without listing conversations again.
  const listed = fakeLists;
  await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', timeZone: 'UTC', whenISO: '2099-01-01T12:00:00Z' });
  await settle();
  assert.equal(app.trayMenu.find((item) => String(item.label).startsWith('Scheduled messages')).label, 'Scheduled messages (1)');
  assert.equal(fakeLists, listed);
});

test('a paused continuation with an unconfirmed delivery offers Check delivery and a confirmed Mark as not delivered in the tray', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const chain = { limit: null, state: 'paused', reasonCode: 'delivery_unconfirmed', reason: 'Check delivery before resuming.', changedAt: '2026-10-01T09:00:00Z', previousTurns: 0, history: [] };
  const job = { harness: 'fake', threadId: 'conv-1', message: 'Keep going', scheduleAt: '2026-10-01T08:00:00Z', createdAt: '2026-10-01T08:00:00Z', timeZone: 'UTC', bufferSeconds: 5, trigger: 'available', waitReason: 'availability',
    id: 'uncertain', commandId: 'c2', messageId: 'm2', status: 'unconfirmed', deliveryCertainty: 'unknown', dispatchAttemptedAt: '2026-10-01T08:00:05Z', chain };
  const app = appHarness([], { rawJobs: JSON.stringify({ version: 4, jobs: [job] }), extraHarnesses: () => [fake.adapter] });
  await settle();
  const items = () => app.trayMenu.find((item) => String(item.label).startsWith('Scheduled messages')).submenu[0].submenu;
  assert.deepEqual(plain(items().map((item) => item.label)), ['View schedule', 'Check delivery', 'Mark as not delivered…', 'Resume continuation', 'Stop continuing']);
  assert.equal(items().find((item) => item.label === 'Resume continuation').enabled, false);
  items().find((item) => item.label === 'Check delivery').click();
  await settle();
  assert.equal(app.invoke('jobs:get', 'uncertain').deliveryStatus, 'unconfirmed');
  // Cancel in the confirmation leaves it alone.
  items().find((item) => item.label === 'Mark as not delivered…').click();
  await settle();
  assert.equal(app.dialogs.length, 1);
  assert.match(app.dialogs[0].detail, /sends the same message again with a new delivery key/);
  assert.equal(app.invoke('jobs:get', 'uncertain').deliveryStatus, 'unconfirmed');
  app.setDialogResponse(0);
  items().find((item) => item.label === 'Mark as not delivered…').click();
  await settle();
  const marked = app.invoke('jobs:get', 'uncertain');
  assert.deepEqual(plain([marked.deliveryStatus, marked.automation.reasonCode, marked.canResume, marked.notDeliveredMarks[0].source]), ['failed', 'marked_not_delivered', true, 'tray']);
  assert.deepEqual(plain(items().map((item) => item.label)), ['View schedule', 'Resume continuation', 'Stop continuing']);
  assert.equal(items().find((item) => item.label === 'Resume continuation').enabled, true);
  assert.equal(fake.state.submitted.length, 0);
});

test('the window marks over IPC only with confirm: true', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const job = { harness: 'fake', threadId: 'conv-1', message: 'Continue', scheduleAt: '2026-10-01T08:00:00Z', createdAt: '2026-10-01T08:00:00Z', timeZone: 'UTC', bufferSeconds: 5,
    id: 'uncertain', commandId: 'c2', messageId: 'm2', status: 'unconfirmed', deliveryCertainty: 'unknown', dispatchAttemptedAt: '2026-10-01T08:00:05Z' };
  const app = appHarness([], { rawJobs: JSON.stringify({ version: 4, jobs: [job] }), extraHarnesses: () => [fake.adapter] });
  await assert.rejects(app.invoke('jobs:mark-not-delivered', 'uncertain'), /Confirm that the message did not arrive/);
  await assert.rejects(app.invoke('jobs:mark-not-delivered', 'uncertain', { confirm: 'true' }), /Confirm/);
  const marked = await app.invoke('jobs:mark-not-delivered', 'uncertain', { confirm: true });
  assert.deepEqual(plain([marked.deliveryStatus, marked.notDeliveredMarks[0].source]), ['failed', 'desktop']);
  assert.equal(app.invoke('jobs:schedule-again', 'uncertain').threadId, 'conv-1');
  assert.equal(JSON.parse(app.files.get('/fixture/jobs.json')).jobs[0].error.code, 'marked_not_delivered');
});

test('IPC describes stop phrase support per harness and creates a chain with one', async () => {
  const { createFakeHarness: make } = require('../tools/fake-harness.cjs');
  const fake = make({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const app = appHarness([], { extraHarnesses: () => [fake.adapter] });
  const described = app.invoke('harnesses:list').harnesses;
  for (const item of described) assert.equal(item.automation.stopPhrase.supported, item.capabilities.canReportAgentMessage === true, item.id);
  assert.equal(described.find((item) => item.id === 't3').capabilities.canReportAgentMessage, true);
  fake.state.availability = { state: 'limited', resetsAt: '2099-01-01T00:00:00Z', source: 'reported' };
  const created = await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', timeZone: 'UTC', trigger: 'available', continuous: true, stopPhrase: 'TASK COMPLETE' });
  assert.equal(created.automation.stopPhrase, 'TASK COMPLETE');
  assert.equal(app.invoke('jobs:edit', created.id, { message: 'Continue', trigger: 'available', continuous: true }).automation.stopPhrase, 'TASK COMPLETE');
});
