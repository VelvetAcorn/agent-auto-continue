'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { appHarness } = require('./app-harness');

test('dashboard IPC shows friendly HTML error and acknowledgment clears historical alert after restart', async () => {
  const job = { id: 'job', commandId: 'command', messageId: 'message', threadId: 'thread', message: 'Continue', scheduleAt: '2026-01-01T00:00:00Z', status: 'failed', note: 'Unexpected token \'<\', "<!doctype "... is not valid JSON' };
  const app = appHarness([job]);
  const state = await app.invoke('dashboard:threads');
  assert.equal(state.online, false);
  assert.match(state.error, /webpage/);
  assert.doesNotMatch(state.failedJobs[0].note, /Unexpected token|doctype/);
  assert.doesNotMatch(JSON.stringify(state), /test-secret/);
  const checked = await app.invoke('connection:check');
  assert.equal(checked.error.code, 'unexpected_response_format');
  app.invoke('jobs:acknowledge', 'job');
  assert.equal((await app.invoke('dashboard:threads')).failedJobs.length, 0);
  const restarted = appHarness(JSON.parse(app.files.get('/fixture/jobs.json')));
  assert.equal((await restarted.invoke('dashboard:threads')).failedJobs.length, 0);
  assert.equal(restarted.invoke('jobs:list', { view: 'history' }).jobs.length, 1);
});

test('IPC create/edit/cancel and settings preserve per-job buffer with no live server', async () => {
  const app = appHarness();
  app.setResponse(async url => new Response(JSON.stringify(url.includes('/threads/') ? { thread: { id: 'thread', title: 'Test', messages: [], projectId: 'p' } } : { threads: [], projects: [] }), { headers: { 'content-type': 'application/json' } }));
  const input = { threadId: 'thread', message: 'Continue', whenISO: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC' };
  const job = await app.invoke('schedule:create', input);
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 60 });
  const edited = app.invoke('jobs:edit', job.id, { ...input, message: 'Proceed' });
  assert.equal(edited.bufferSeconds, 5);
  assert.equal(app.invoke('jobs:list', { view: 'upcoming' }).total, 1);
  app.invoke('jobs:cancel', job.id);
  assert.equal(app.invoke('jobs:list', { view: 'upcoming' }).total, 0);
  assert.equal(app.invoke('jobs:list', { view: 'history' }).jobs[0].status, 'canceled');
});

test('preload exposes narrow job events with working listener cleanup', () => {
  let bridge;
  const listeners = new Map();
  const ipcRenderer = { invoke: (...args) => args, on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  let calls = 0;
  const unsubscribe = bridge.onJobsChanged(() => calls++);
  listeners.get('jobs:changed')();
  unsubscribe();
  assert.equal(calls, 1);
  assert.equal(listeners.size, 0);
  assert.equal(bridge.listJobs({ view: 'history' })[0], 'jobs:list');
  assert.deepEqual(bridge.openPermissionSettings('https://evil.example'), ['harnesses:open-permission-settings'], 'The permission bridge forwards no URL');
});


test('all application entrypoints reuse the dashboard and defer navigation until loaded', async () => {
  const app = appHarness();
  assert.equal(app.windows.length, 1);
  assert.match(app.windows[0].file, /dashboard\.html$/);
  assert.equal(app.windows[0].options.webPreferences.sandbox, true);
  assert.equal(app.windows[0].options.webPreferences.contextIsolation, true);
  app.invoke('dashboard:open-settings');
  assert.equal(app.events.some(([name]) => name === 'app:navigate'), false);
  app.windows[0].finishLoad();
  assert.equal(app.events.at(-1)[1].view, 'settings');
  app.setResponse(async () => new Response(JSON.stringify({ threads: [{ id: 'thread', title: 'Test', settledOverride: null }], projects: [] }), { headers: { 'content-type': 'application/json' } }));
  await app.invoke('dashboard:schedule-thread', 'thread');
  assert.equal(app.windows.length, 1);
  assert.equal(app.events.at(-1)[1].view, 'composer');
  assert.equal(app.events.at(-1)[1].threadId, 'thread');
  app.invoke('dashboard:open-settings');
  assert.equal(app.windows.length, 1);
  assert.equal(app.events.at(-1)[1].view, 'settings');
});

test('settings changes broadcast public config and job mutations broadcast live updates', async () => {
  const app = appHarness();
  app.windows[0].finishLoad();
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 12, t3Token: 'private-stored-token' });
  const event = app.events.find(([name]) => name === 'settings:changed');
  assert.equal(event[1].bufferSeconds, 12);
  assert.equal(event[1].hasStoredToken, true);
  assert.doesNotMatch(JSON.stringify(event), /private-stored-token/);
  app.setResponse(async url => new Response(JSON.stringify(url.includes('/threads/') ? { thread: { id: 'thread', messages: [], title: 'Test' } } : { projects: [], threads: [] }), { headers: { 'content-type': 'application/json' } }));
  const job = await app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00Z', timeZone: 'UTC' });
  assert.ok(app.events.some(([name]) => name === 'jobs:changed'));
  app.invoke('jobs:cancel', job.id);
  assert.ok(app.events.filter(([name]) => name === 'jobs:changed').length >= 2);
});


test('a second instance never starts another scheduler or window', () => {
  const app = appHarness([], { ownsInstance: false });
  assert.equal(app.windows.length, 0);
  assert.deepEqual(JSON.parse(app.files.get('/fixture/jobs.json')), []);
});

test('settings persistence failure leaves active configuration unchanged', () => {
  const app = appHarness();
  const original = app.invoke('settings:get');
  app.setWriteFailure(true);
  assert.throws(() => app.invoke('settings:save', { httpPort: 9999, bufferSeconds: 90 }), /Disk full/);
  assert.deepEqual(app.invoke('settings:get'), original);
  assert.equal(app.events.some(([name]) => name === 'settings:changed'), false);
});


test('corrupt and future-version schedule files are preserved and block scheduling visibly', () => {
  for (const rawJobs of ['{"jobs":', JSON.stringify({ version: 5, jobs: [] }), JSON.stringify([{ id: 'invalid-record' }])]) {
    const app = appHarness([], { rawJobs });
    assert.equal(app.files.get('/fixture/jobs.json'), rawJobs);
    const state = app.invoke('jobs:list');
    assert.equal(state.storageError.code, 'storage_unavailable');
    assert.match(state.storageError.message, /Existing data has not been changed/);
    assert.throws(() => app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00Z' }));
    assert.equal(app.files.get('/fixture/jobs.json'), rawJobs);
    assert.equal(app.windows.length, 1, 'The recovery message remains accessible in the app');
  }
});

test('the production registry is described over IPC without touching any harness', () => {
  const app = appHarness();
  const { harnesses, defaultHarness } = app.invoke('harnesses:list');
  assert.equal(defaultHarness, 't3');
  assert.equal(harnesses.map((item) => item.id).join(), 't3,opencode,claude-code,claude-desktop,codex,codex-desktop');
  for (const item of harnesses) {
    assert.equal(item.capabilities.requiresUnlockedScreen, item.kind === 'desktop-app', item.id);
    assert.equal(typeof item.capabilities.canDetectCompletion, 'boolean');
  }
  assert.equal(harnesses.find((item) => item.id === 'opencode').settings.map((setting) => setting.key).join(), 'port,password');
});

test('the permission IPC opens only the fixed Accessibility pane, whatever the renderer passes', async () => {
  const { ACCESSIBILITY_SETTINGS_URL } = require('../lib/desktop/mac-automation');
  const app = appHarness();
  await app.invoke('harnesses:open-permission-settings');
  await app.invoke('harnesses:open-permission-settings', 'https://evil.example', { url: 'file:///etc/passwd' });
  assert.deepEqual(app.opened, [ACCESSIBILITY_SETTINGS_URL, ACCESSIBILITY_SETTINGS_URL]);
  assert.equal(ACCESSIBILITY_SETTINGS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

test('conversations, schedules and connection checks are routed to the chosen harness', async () => {
  const { createFakeHarness } = require('../tools/fake-harness.cjs');
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation', projectName: 'Repo' }] });
  const app = appHarness([], { extraHarnesses: () => [fake.adapter] });
  const listed = await app.invoke('dashboard:threads', { harness: 'fake', showSettled: true });
  assert.equal(listed.online, true);
  assert.equal(JSON.stringify(listed.threads.map((thread) => [thread.harness, thread.id])), JSON.stringify([['fake', 'conv-1']]));
  assert.equal((await app.invoke('connection:check', 'fake')).online, true);
  fake.state.connectionError = new (require('../lib/harnesses/errors').HarnessError)('connection_refused', 'Fake is not running.');
  assert.equal((await app.invoke('connection:check', 'fake')).error.code, 'connection_refused');
  const unknown = await app.invoke('dashboard:threads', { harness: 'nope' });
  assert.equal(unknown.online, false);
  assert.equal(unknown.errorInfo.code, 'unknown_harness');
  const job = await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', whenISO: '2099-01-01T12:00:00Z', timeZone: 'UTC' });
  assert.equal(job.harness, 'fake');
  assert.equal(job.harnessLabel, 'Fake Agent');
  assert.equal(JSON.parse(app.files.get('/fixture/jobs.json')).version, 4);
  assert.equal(JSON.parse(app.files.get('/fixture/jobs.json')).jobs[0].harness, 'fake');
  assert.equal((await app.invoke('harnesses:availability', 'fake')).availability.state, 'available');
  assert.equal((await app.invoke('harnesses:availability', 't3')).availability.state, 'unknown');
  app.windows[0].finishLoad();
  await app.invoke('dashboard:schedule-thread', 'conv-1', 'fake');
  assert.equal(JSON.stringify(app.events.at(-1)[1]), JSON.stringify({ view: 'composer', threadId: 'conv-1', threadLabel: 'Fake conversation', harness: 'fake' }));
  assert.equal(fake.state.submitted.length, 0);
});

test('harness settings are validated, persisted and never returned in clear text', () => {
  const app = appHarness([], { env: { T3_TOKEN: 'test-secret', OPENCODE_SERVER_PASSWORD: '' } });
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { port: 4555, password: 'oc-secret' }, 'claude-code': { executable: '/opt/claude' } } });
  const saved = JSON.parse(app.files.get('/fixture/config.json'));
  assert.equal(JSON.stringify(saved.harnesses), JSON.stringify({ opencode: { port: 4555, password: 'oc-secret' }, 'claude-code': { executable: '/opt/claude' } }));
  const shown = app.invoke('settings:get');
  assert.equal(JSON.stringify(shown.harnesses.opencode.password), JSON.stringify({ hasStoredValue: true, usingEnvironment: false }));
  assert.equal(shown.harnesses.opencode.port.value, 4555);
  assert.doesNotMatch(JSON.stringify(shown), /oc-secret/);
  assert.throws(() => app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { port: 70000 } } }), /port/);
  assert.throws(() => app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { unknown: {} } }), /Unknown/);
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { password: '' } } });
  assert.equal(JSON.parse(app.files.get('/fixture/config.json')).harnesses.opencode.password, 'oc-secret', 'A blank secret keeps the stored value');
});

test('continuations are created, stopped and described over IPC and the tray', async () => {
  const { createFakeHarness } = require('../tools/fake-harness.cjs');
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const app = appHarness([], { extraHarnesses: () => [fake.adapter] });
  const described = app.invoke('harnesses:list').harnesses;
  assert.equal(described.find((item) => item.id === 't3').automation.whenAvailable.supported, false);
  assert.match(described.find((item) => item.id === 't3').automation.whenAvailable.reason, /T3 Code does not report usage limits/);
  assert.equal(described.find((item) => item.id === 'fake').automation.multipleTurns.supported, true);
  await assert.rejects(async () => app.invoke('schedule:create', { harness: 't3', threadId: 'thread', message: 'Continue', timeZone: 'UTC', trigger: 'available' }), /does not report usage limits/);
  fake.state.availability = { state: 'limited', resetsAt: '2099-01-01T00:00:00Z', source: 'reported' };
  const first = await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', timeZone: 'UTC', trigger: 'available', continuous: true });
  const second = await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', timeZone: 'UTC', trigger: 'time', whenISO: '2099-01-01T12:00:00Z', turnLimit: 4 });
  assert.equal(first.automation.unlimited, true);
  assert.equal(second.automation.limit, 4);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stopItem = () => app.trayMenu.find((item) => String(item.label).startsWith('Stop all continuations'));
  await settle();
  assert.equal(stopItem().label, 'Stop all continuations (2)');
  const perJob = app.trayMenu.find((item) => String(item.label).startsWith('Scheduled messages')).submenu;
  assert.ok(perJob.every((item) => item.submenu.some((entry) => entry.label === 'Stop continuing')));
  assert.equal(app.invoke('jobs:stop', first.id).automation.state, 'stopped');
  await settle();
  assert.equal(stopItem().label, 'Stop all continuations (1)');
  stopItem().click();
  assert.equal(app.invoke('jobs:get', second.id).automation.state, 'stopped');
  await settle();
  assert.equal(stopItem(), undefined);
  assert.equal(JSON.stringify(app.invoke('jobs:stop-all')), JSON.stringify({ stopped: [] }));
  assert.throws(() => app.invoke('jobs:resume', first.id), /Only paused/);
  assert.equal(fake.state.submitted.length, 0);
});


test('paused continuations appear per schedule in the tray with their state, Resume when allowed, and Stop', async () => {
  const { createFakeHarness } = require('../tools/fake-harness.cjs');
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation' }] });
  const chain = (reasonCode, reason) => ({ limit: null, state: 'paused', reasonCode, reason, changedAt: '2026-10-01T09:00:00Z', previousTurns: 0, history: [] });
  const base = { harness: 'fake', threadId: 'conv-1', message: 'Keep going', scheduleAt: '2026-10-01T08:00:00Z', createdAt: '2026-10-01T08:00:00Z', timeZone: 'UTC', bufferSeconds: 5, trigger: 'available', waitReason: 'availability' };
  const jobs = [
    { ...base, id: 'paused', commandId: 'c1', messageId: 'm1', status: 'pending', deliveryCertainty: 'not-delivered', chain: chain('user_activity', 'New user activity appeared in the session. Resume to keep continuing.') },
    { ...base, id: 'uncertain', commandId: 'c2', messageId: 'm2', status: 'unconfirmed', deliveryCertainty: 'unknown', dispatchAttemptedAt: '2026-10-01T08:00:05Z', chain: chain('delivery_unconfirmed', 'Check delivery before resuming.') }
  ];
  const app = appHarness([], { rawJobs: JSON.stringify({ version: 4, jobs }), extraHarnesses: () => [fake.adapter] });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  const section = () => app.trayMenu.find((item) => String(item.label).startsWith('Scheduled messages'));
  const entry = (id) => section().submenu.find((item) => item.submenu.some((child) => child.id === `view:${id}`));
  assert.equal(section().label, 'Scheduled messages (2)');
  for (const id of ['paused', 'uncertain']) {
    assert.match(entry(id).label, /Keep going · Turn 1 · continuous · paused/);
    assert.ok(entry(id).submenu.some((child) => child.label === 'Stop continuing'));
  }
  const resume = (id) => entry(id).submenu.find((child) => child.label === 'Resume continuation');
  assert.equal(resume('paused').enabled, true);
  assert.equal(resume('uncertain').enabled, false, 'Resume waits for Check delivery');
  resume('paused').click();
  assert.equal(app.invoke('jobs:get', 'paused').automation.state, 'active');
  await settle();
  assert.equal(entry('paused').submenu.some((child) => child.label === 'Resume continuation'), false, 'A running chain offers Stop only');
  entry('uncertain').submenu.find((child) => child.label === 'Stop continuing').click();
  assert.equal(app.invoke('jobs:get', 'uncertain').automation.state, 'stopped');
  await settle();
  assert.equal(entry('uncertain'), undefined);
  assert.equal(fake.state.submitted.length, 0);
});

test('keep-awake IPC is opt-in, persists settings, shows the tray state and releases on stop and quit', async () => {
  const pending = { id: 'pending', commandId: 'command', messageId: 'message', threadId: 'thread', threadTitle: 'Night shift', message: 'Continue', scheduleAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'pending', bufferSeconds: 5 };
  const app = appHarness([pending]);
  app.setResponse(async () => new Response(JSON.stringify({ threads: [], projects: [] }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(app.invoke('keep-awake:get').state, 'off');
  assert.equal(app.blockers.size, 0, 'Nothing is held until the user opts in');
  const settings = { enabled: true, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 20, maxHours: 8, includeRunningAgents: false };
  assert.throws(() => app.invoke('keep-awake:configure', { ...settings, maxHours: 0 }), /Time limit/);
  const armed = app.invoke('keep-awake:configure', settings);
  assert.equal(armed.state, 'armed');
  assert.deepEqual(armed.tasks.map((task) => [task.id, task.label, task.state]), [['job:pending', 'Night shift', 'waiting']]);
  assert.deepEqual([...app.blockers.values()], ['prevent-app-suspension']);
  assert.deepEqual(JSON.parse(app.files.get('/fixture/config.json')).keepAwake, settings);
  assert.ok(app.events.some(([channel, snapshot]) => channel === 'keep-awake:changed' && snapshot.state === 'armed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.trayTooltip, 'T3 Code Auto-Continue · Keeping Mac awake');
  assert.ok(app.trayMenu.find((item) => item.label === 'Keeping Mac awake · 1 task'));
  app.trayMenu.find((item) => item.label === 'Let Mac sleep now').click();
  assert.equal(app.invoke('keep-awake:get').state, 'ended');
  assert.equal(app.blockers.size, 0);
  assert.equal(app.invoke('keep-awake:resume').state, 'armed');
  assert.equal(app.blockers.size, 1);
  app.invoke('jobs:cancel', 'pending');
  assert.equal(app.invoke('keep-awake:get').state, 'releasing', 'Canceling the last task starts the release grace');
  assert.equal(app.invoke('keep-awake:stop').state, 'off');
  assert.equal(app.blockers.size, 0);

  const restarted = appHarness([{ ...pending, id: 'second' }], { config: { httpPort: 3773, bufferSeconds: 5, keepAwake: settings } });
  assert.equal(restarted.invoke('keep-awake:get').state, 'armed', 'A saved opt-in resumes after restart');
  assert.equal(restarted.blockers.size, 1);
  restarted.powerEvents.suspend();
  await restarted.powerEvents.resume();
  await restarted.emit('will-quit');
  assert.equal(restarted.blockers.size, 0, 'Quitting releases the assertion');
});
