'use strict';
// Shared fixture for remote control tests: a real JobService and RemoteControl
// served over real loopback HTTP, with an in-memory harness that never sends.
const net = require('node:net');
const { JobService } = require('../lib/job-service');
const { ApiError } = require('../lib/api-client');
const { RemoteControl } = require('../lib/remote');
const { createT3HarnessSource } = require('../lib/remote/harnesses');

function fakeHarness() {
  const harness = {
    online: true,
    dispatches: 0,
    threads: [
      { id: 'thread-a', title: 'Refactor parser', projectId: 'project-1', updatedAt: '2026-09-30T10:00:00.000Z', settledOverride: null, messages: [], modelSelection: {}, runtimeMode: 'full-access', interactionMode: 'default' },
      { id: 'thread-b', title: 'Write docs', projectId: 'project-2', updatedAt: '2026-09-30T11:00:00.000Z', settledOverride: 'settled', messages: [], modelSelection: {}, runtimeMode: 'full-access', interactionMode: 'default' },
      { id: 'thread-archived', title: 'Old', projectId: 'project-1', archivedAt: '2026-01-01T00:00:00.000Z', messages: [] }
    ],
    projects: [{ id: 'project-1', title: 'Parser' }, { id: 'project-2', name: 'Docs' }]
  };
  const offline = () => new ApiError('connection_refused', 'Cannot connect to T3 Code. Check that it is running and the port in Settings is correct.', { endpoint: 'snapshot', port: 3773 });
  harness.api = {
    async fetchSnapshot() { if (!harness.online) throw offline(); return { threads: harness.threads, projects: harness.projects }; },
    async fetchThread(id) {
      if (!harness.online) throw offline();
      const thread = harness.threads.find((item) => item.id === id);
      if (!thread) throw new ApiError('http_failure', 'T3 Code returned HTTP 404. Check the connection and API compatibility.', { status: 404, endpoint: 'threads' });
      return thread;
    },
    async dispatch() { harness.dispatches++; throw new Error('Dispatch is prohibited in tests.'); }
  };
  return harness;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Starts remote control on a free loopback port with one control token and one read token.
 * `harnesses`, when given, builds a registry from the fake harness.
 * `automation` is a run provider, or a function given `{ getService, ensureStorage }` that builds one.
 */
async function startRemote({ enabled = true, jobs = [], storageError = null, networkInterfaces = () => ({}), keepAwake, automation, harnesses, initialState, now } = {}) {
  const harness = fakeHarness();
  const files = { saved: initialState, failSave: false };
  let storage = storageError;
  const service = new JobService({ jobs, api: harness.api, persist: () => { if (storage) throw new Error(storage.message); }, ...(now ? { now } : {}) });
  const timers = [];
  const ensureStorage = () => { if (storage) throw new Error(storage.message); };
  if (typeof automation === 'function') automation = automation({ getService: () => service, ensureStorage });
  const remote = new RemoteControl({
    load: () => files.saved, save: (state) => { if (files.failSave) throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); files.saved = JSON.parse(JSON.stringify(state)); },
    getService: () => service, ensureStorage, getStorageError: () => storage,
    harnesses: harnesses ? harnesses(harness) : createT3HarnessSource(harness.api), keepAwake, automation, appInfo: { name: 'Agent Auto-Continue test', version: '0.0.0-test' },
    networkInterfaces, setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimer: () => {},
    ...(now ? { now } : {})
  });
  let control, read;
  if (!remote.loadError) {
    control = remote.createToken({ label: "Ryan's iPhone", scope: 'control' });
    read = remote.createToken({ label: 'Dashboard', scope: 'read' });
  }
  const port = await freePort();
  if (enabled && !remote.loadError) await remote.configure({ enabled: true, port });
  const base = `http://127.0.0.1:${port}`;
  async function request(method, path, { body, headers = {}, token = control.token, raw } = {}) {
    const response = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
  return {
    remote, service, harness, files, timers, port, base, request, control, read,
    setStorageError: (value) => { storage = value; },
    setSaveFailure: (value) => { files.failSave = value; },
    close: () => remote.stop()
  };
}

module.exports = { fakeHarness, freePort, startRemote };
