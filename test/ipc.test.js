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
  for (const rawJobs of ['{"jobs":', JSON.stringify({ version: 3, jobs: [] }), JSON.stringify([{ id: 'invalid-record' }])]) {
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
