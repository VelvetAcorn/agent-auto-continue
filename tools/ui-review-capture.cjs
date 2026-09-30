'use strict';
// UI review evidence capture (issue #6).
// Runs the production main process, preload and renderer (same injection approach as
// tools/electron-smoke.cjs) against in-memory storage and a fake T3 Code API with
// realistic data, then captures screenshots, keyboard tab order and accessibility trees.
// No network request or real message send can occur: every POST is held or rejected.
//
// Usage: env -u ELECTRON_RUN_AS_NODE npx electron tools/ui-review-capture.cjs
//   UI_REVIEW_OUT=docs/ui-review/screens (default)
//   UI_REVIEW_SCENARIO=populated | empty | storage | loading | no-token
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const electron = require('electron');
const { app, BrowserWindow } = electron;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 't3-scheduler-review-')));
const root = path.resolve(__dirname, '..');
const scenario = process.env.UI_REVIEW_SCENARIO || 'populated';
const out = path.resolve(root, process.env.UI_REVIEW_OUT || 'docs/ui-review/screens');
const dataOut = path.join(os.tmpdir(), 'aac-ui-review-data');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(dataOut, { recursive: true });

const NOW = Date.now();
const iso = (offsetMinutes) => new Date(NOW + offsetMinutes * 60000).toISOString();
const minute = 1, hour = 60, day = 1440;
const projects = [{ id: 'p-aac', title: 'agent-auto-continue' }, { id: 'p-quilla', title: 'Quilla' }, { id: 'p-notes', title: 'field-notes' }];
const base = { messages: [], modelSelection: { model: 'fixture', instanceId: 'fixture' }, runtimeMode: 'full-access', interactionMode: 'default', settledOverride: null };
const threads = [
  { id: 't-sched', title: 'Polish the scheduler experience', projectId: 'p-aac', updatedAt: iso(-12 * minute) },
  { id: 't-due', title: 'Refactor the sync worker', projectId: 'p-aac', updatedAt: iso(-40 * minute) },
  { id: 't-checkout', title: 'Audit checkout edge cases before the autumn release', projectId: 'p-quilla', updatedAt: iso(-2 * hour) },
  { id: 't-long', title: 'Investigate why the nightly export job intermittently times out when the upstream warehouse is under heavy load and retries overlap with the weekly compaction window', projectId: 'p-notes', updatedAt: iso(-3 * hour) },
  { id: 't-release', title: 'Draft release notes for 2.1', projectId: 'p-aac', updatedAt: iso(-5 * hour) },
  { id: 't-onboard', title: 'Review onboarding copy', projectId: 'p-quilla', updatedAt: iso(-1 * day), settledOverride: 'pinned' },
  { id: 't-tray', title: 'Rename the tray menu items', projectId: 'p-aac', updatedAt: iso(-2 * day) },
  { id: 't-migration', title: 'Document the completed migration', projectId: 'p-quilla', updatedAt: iso(-3 * day), settledOverride: 'settled' },
  { id: 't-untitled', title: '', projectId: 'p-notes', updatedAt: iso(-5 * day) },
  { id: 't-backoff', title: 'Tune retry backoff for the webhook relay', projectId: 'p-notes', updatedAt: iso(-8 * day) },
  { id: 't-mobile', title: 'Sketch the mobile control page', projectId: 'p-aac', updatedAt: null }
].map((thread) => ({ ...base, ...thread }));
const titleOf = (id) => threads.find((t) => t.id === id).title || '(Untitled thread)';
const projectOf = (id) => projects.find((p) => p.id === threads.find((t) => t.id === id).projectId).title;
let seq = 0;
function job(threadId, fields) {
  seq++;
  return { id: fields.id || `job-${seq}`, commandId: `command-${seq}`, messageId: `message-${seq}`, threadId, threadTitle: titleOf(threadId), projectId: threads.find((t) => t.id === threadId).projectId, projectName: projectOf(threadId), message: 'Continue', bufferSeconds: 5, timeZone: 'Europe/London', deliveryCertainty: 'not-delivered', acknowledgedAt: null, note: '', ...fields };
}
const longMessage = 'Run the checkout regression suite again with the new tax fixtures.\nIf anything fails, summarise the failure, propose the smallest safe fix and wait for me before changing the payment adapter.\nAlso double-check the rounding on multi-currency baskets.';
const jobs = [
  job('t-due', { id: 'due', message: 'Continue with the sync worker refactor.', scheduleAt: iso(-90 / 60), createdAt: iso(-1 * hour), updatedAt: iso(-1 * hour), status: 'pending' }),
  job('t-sched', { id: 'pending-soon', scheduleAt: iso(25 * minute), createdAt: iso(-5 * minute), updatedAt: iso(-5 * minute), status: 'pending' }),
  job('t-checkout', { id: 'pending-long-message', message: longMessage, scheduleAt: iso(2 * hour + 4), createdAt: iso(-20), updatedAt: iso(-20), status: 'pending' }),
  job('t-long', { id: 'pending-long-title', scheduleAt: iso(18 * hour), createdAt: iso(-30), updatedAt: iso(-30), status: 'pending' }),
  job('t-onboard', { id: 'pending-ny', message: 'Continue', scheduleAt: iso(3 * day + 60), createdAt: iso(-2 * hour), updatedAt: iso(-2 * hour), status: 'pending', timeZone: 'America/New_York' }),
  job('t-release', { id: 'pending-far', message: 'Continue - and when you finish, draft the changelog summary.', scheduleAt: iso(41 * day), createdAt: iso(-3 * hour), updatedAt: iso(-3 * hour), status: 'pending', bufferSeconds: 30 }),
  job('t-tray', { id: 'pending-tokyo', scheduleAt: iso(6 * day), createdAt: iso(-1 * day), updatedAt: iso(-1 * day), status: 'pending', timeZone: 'Asia/Tokyo' }),
  // History
  job('t-sched', { id: 'sent', message: 'Continue', scheduleAt: iso(-65), createdAt: iso(-3 * hour), updatedAt: iso(-65), dispatchedAt: iso(-65), status: 'sent', deliveryCertainty: 'delivered', note: 'Sent to T3 Code' }),
  job('t-backoff', { id: 'sent-late', message: 'Continue', scheduleAt: iso(-10 * hour), createdAt: iso(-20 * hour), updatedAt: iso(-9 * hour - 15), dispatchedAt: iso(-9 * hour - 15), lateBySeconds: 2710, status: 'sent', deliveryCertainty: 'delivered', note: 'Sent to T3 Code' }),
  job('t-checkout', { id: 'failed-auth', message: 'Run the integration tests and report back.', scheduleAt: iso(-18), createdAt: iso(-4 * hour), updatedAt: iso(-18), status: 'failed', deliveryCertainty: 'not-delivered', note: 'T3 Code rejected the token. Check Settings.', error: { code: 'authentication_rejected', message: 'T3 Code rejected the token. Check Settings.', details: { endpoint: 'threads/t-checkout', port: 3773, status: 401, contentType: 'application/json' }, deliveryUncertain: false } }),
  job('t-release', { id: 'unconfirmed', message: 'Continue', scheduleAt: iso(-2 * hour), createdAt: iso(-6 * hour), updatedAt: iso(-100), dispatchAttemptedAt: iso(-2 * hour), lastReconciledAt: iso(-100), status: 'unconfirmed', deliveryCertainty: 'unknown', note: 'T3 Code did not respond in time. Check the connection.', error: { code: 'timeout', message: 'T3 Code did not respond in time. Check the connection.', details: { endpoint: 'dispatch', port: 3773 }, deliveryUncertain: true } }),
  job('t-onboard', { id: 'canceled-activity', message: 'Continue', scheduleAt: iso(-5 * hour), createdAt: iso(-7 * hour), updatedAt: iso(-5 * hour), status: 'canceled', note: 'New user activity appeared after this schedule was created' }),
  job('t-tray', { id: 'canceled-user', message: 'Continue', scheduleAt: iso(-1 * day), createdAt: iso(-2 * day), updatedAt: iso(-1 * day - 30), status: 'canceled', note: 'Canceled by user' }),
  job('t-migration', { id: 'canceled-archived', scheduleAt: iso(-2 * day), createdAt: iso(-3 * day), updatedAt: iso(-2 * day), status: 'canceled', note: 'Thread is archived' }),
  job('t-sched', { id: 'failed-ack', message: 'Continue', scheduleAt: iso(-3 * day), createdAt: iso(-4 * day), updatedAt: iso(-3 * day), acknowledgedAt: iso(-2 * day), status: 'failed', deliveryCertainty: 'not-delivered', error: { code: 'connection_refused', message: 'Cannot connect to T3 Code. Check that it is running and the port in Settings is correct.', details: { endpoint: 'threads/t-sched', port: 3773 }, deliveryUncertain: false }, note: 'Cannot connect to T3 Code.' }),
  { id: 'legacy', commandId: 'legacy-c', messageId: 'legacy-m', threadId: 't-sched', message: 'Continue', scheduleAt: iso(-20 * day), status: 'sent' }
];
for (let index = 0; index < 60; index++) jobs.push(job(threads[index % 6].id, { id: `bulk-${index}`, message: index % 3 ? 'Continue' : 'Continue where you left off and summarise progress.', scheduleAt: iso(-(4 + index) * day), createdAt: iso(-(5 + index) * day), updatedAt: iso(-(4 + index) * day), status: 'sent', deliveryCertainty: 'delivered', note: 'Sent to T3 Code' }));

const files = new Map();
if (scenario === 'populated' || scenario === 'loading' || scenario === 'no-token') files.set('/fixture/jobs.json', JSON.stringify({ version: 2, jobs }));
if (scenario === 'storage') files.set('/fixture/jobs.json', '{"version":2,"jobs":[{"id":');
const fakeFs = {
  readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' }); return files.get(name); },
  mkdirSync() {}, writeFileSync(name, value) { if (scenario === 'storage') throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); files.set(name, value); },
  renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
};

let apiMode = scenario === 'loading' ? 'slow' : 'online';
let heldPost;
const posts = [];
const timers = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixtureFetch(url, options = {}) {
  if (apiMode === 'slow') await delay(60_000);
  if (apiMode === 'refused') throw new TypeError('fetch failed');
  if (apiMode === 'html') return new Response('<!doctype html><html>Not the API</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (options.method === 'POST') {
    posts.push(url);
    // Hold the dispatch so the Sending state can be captured, then reject it as an auth failure.
    await new Promise((resolve) => { heldPost = resolve; });
    return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const match = /threads\/([^?]+)/.exec(url);
  const payload = match ? { snapshotSequence: 1, thread: threads.find((t) => t.id === decodeURIComponent(match[1])) } : { snapshotSequence: 1, projects, threads };
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

const apiModule = require('../lib/api-client');
const appProxy = new Proxy(app, { get(target, property) {
  if (property === 'requestSingleInstanceLock') return () => true;
  if (property === 'getPath') return (name) => name === 'userData' ? '/fixture' : target.getPath(name);
  if (property === 'getLoginItemSettings') return () => ({ openAtLogin: false });
  const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
} });
const windows = [];
class FixtureWindow extends BrowserWindow {
  constructor(options) {
    // The real window enforces minWidth 620; lower it here only to evaluate the narrow CSS breakpoints.
    super({ ...options, minWidth: 320, minHeight: 400, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } });
    windows.push(this);
    this.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  }
  // Electron does not list subclassed windows, which would silently drop jobs:changed broadcasts.
  static getAllWindows() { return windows.filter((window) => !window.isDestroyed()); }
  show() {}
  focus() {}
}
const injectedElectron = {
  ...electron, app: appProxy, BrowserWindow: FixtureWindow,
  Tray: class { setToolTip() {} on() {} setContextMenu() {} },
  Menu: { buildFromTemplate: (value) => value }, Notification: { isSupported: () => false },
  shell: { openExternal: async () => {} }, powerMonitor: { on() {} }
};
function loadProductionMain() {
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(name) {
      if (name === 'electron') return injectedElectron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node-schedule') return { scheduleJob: (when, callback) => { const timer = { when, callback, cancel() { timer.canceled = true; } }; timers.push(timer); return timer; } };
      if (name === './lib/api-client') return { ...apiModule, createApiClient: (options) => apiModule.createApiClient({ ...options, fetchImpl: fixtureFetch }) };
      return name.startsWith('./lib/') ? require(path.join(root, name)) : require(name);
    }, __dirname: root, process: { env: scenario === 'no-token' ? {} : { T3_TOKEN: 'fixture-only' }, pid: process.pid }, console, Buffer
  }, { filename: 'main.js' });
}
async function waitFor(check, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  do { if (await check()) return; await delay(40); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

let win, js, cdp;
let width = 1180, height = 800, theme = 'light';
const index = [];
async function size(w, h = 800) { width = w; height = h; win.setContentSize(w, h); await delay(120); }
async function capture(name, { full = false, note = '' } = {}) {
  let restore;
  if (full) {
    const scrollHeight = await js('Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)');
    if (scrollHeight > height) { restore = height; win.setContentSize(width, scrollHeight); await delay(200); }
  }
  await delay(180);
  const image = await win.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  const file = `${scenario === 'populated' ? '' : scenario + '-'}${name}-${theme}-${width}.png`;
  // Save at 1x CSS pixels regardless of the display scale factor to keep evidence small.
  const scaled = image.getSize().width > width ? image.resize({ width, quality: 'best' }) : image;
  fs.writeFileSync(path.join(out, file), scaled.toPNG());
  index.push({ file, note });
  if (restore) { win.setContentSize(width, restore); await delay(120); }
}
async function setTheme(next) {
  theme = next;
  await js(`(() => { const dark = document.body.classList.contains('dark'); if (dark !== ${next === 'dark'}) document.querySelector('[data-action="theme"]').click(); })()`);
  await delay(60);
}
const click = async (selector) => {
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await delay(80);
};
const fill = (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const heading = (expected) => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
const go = async (view, title) => { await click(`[data-nav="${view}"]`); await heading(title); await delay(150); };
const openJob = async (id) => { await click(`[data-job="${id}"]`); await heading('Message details'); };
async function key(keyName, shift = false) {
  const code = { Tab: 9, Enter: 13, Escape: 27, ArrowRight: 39, ArrowDown: 40, ' ': 32 }[keyName];
  for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: keyName, code: keyName === ' ' ? 'Space' : keyName, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
  await delay(30);
}
async function tabOrder(label, count) {
  const stops = [];
  for (let step = 0; step < count; step++) {
    await key('Tab');
    stops.push(await js(`(() => { const el=document.activeElement; if(!el||el===document.body) return 'body'; const cs=getComputedStyle(el); const r=el.getBoundingClientRect(); return [el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.dataset&&Object.keys(el.dataset).length?'['+Object.entries(el.dataset).map(([k,v])=>k+'='+v).join(',')+']':''), (el.getAttribute('aria-label')||el.innerText||el.value||'').replace(/\\s+/g,' ').trim().slice(0,60), 'outline:'+cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor, 'visible:'+(r.bottom>0&&r.top<innerHeight)].join(' | '); })()`));
  }
  return { label, stops };
}
async function axTree(label) {
  const { nodes } = await cdp('Accessibility.getFullAXTree');
  const lines = nodes.filter((n) => !n.ignored && n.role && !['generic', 'none', 'StaticText', 'InlineTextBox', 'LineBreak'].includes(n.role.value))
    .map((n) => `${n.role.value}: ${JSON.stringify((n.name?.value || '').replace(/\s+/g, ' ').slice(0, 110))}${(n.properties || []).filter((p) => ['pressed', 'expanded', 'checked', 'invalid', 'required', 'disabled', 'focusable', 'live', 'describedby'].includes(p.name) && p.name !== 'focusable').map((p) => ` ${p.name}=${JSON.stringify(p.value.value ?? p.value.relatedNodes?.length)}`).join('')}`);
  fs.writeFileSync(path.join(dataOut, `ax-${label}.txt`), lines.join('\n'));
}

async function populatedTour() {
  const report = { tabOrders: [], checks: {} };
  // ---- Light, default 1180 x 800 ----
  await waitFor(() => js(`Boolean(document.querySelector('[data-job="pending-soon"]'))`), 'upcoming rows');
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('connected')`), 'connected');
  await capture('01-upcoming', { note: 'Upcoming queue with 7 schedules, one overdue catch-up at the top' });
  await axTree('upcoming');
  report.checks.navAccessibleNames = await js(`[...document.querySelectorAll('nav button')].map(b=>b.textContent)`);
  // Keyboard: tab through Upcoming from the top.
  await js('document.activeElement?.blur(); window.scrollTo(0,0)');
  report.tabOrders.push(await tabOrder('upcoming', 12));
  await capture('02-upcoming-keyboard-focus', { note: 'Keyboard focus after 12 Tab presses (row focus ring)' });
  await js('document.activeElement?.blur()');
  await fill('#search', 'zebra');
  await capture('03-upcoming-search-empty', { note: 'Search with no matches' });
  await fill('#search', '');
  await openJob('pending-long-message');
  await capture('04-detail-pending', { full: true, note: 'Pending detail with multi-line message' });
  await axTree('detail-pending');
  await click('[data-action="cancel"]');
  await capture('05-detail-cancel-confirm', { full: true, note: 'Inline cancel confirmation' });
  await click('[data-action="keep"]');
  await click('[data-action="edit"]');
  await heading('Edit schedule');
  await capture('06-composer-edit', { full: true, note: 'Edit schedule: thread picker disabled' });
  // Back from Edit returns to the list rather than the detail it came from.
  await click('[data-action="back"]');
  await heading('Upcoming');
  await openJob('pending-long-title');
  await capture('07-detail-long-title', { full: true, note: 'Detail with a very long thread title' });

  // History
  await go('history', 'History');
  await capture('08-history', { note: 'History with attention notice and Load more' });
  await capture('08b-history-full', { full: true, note: 'History full page including Load more' });
  await click('[data-filter="failed"]');
  await delay(200);
  await capture('09-history-filter-failed', { note: 'Failed filter' });
  await click('[data-filter=""]');
  await delay(200);
  await openJob('failed-auth');
  await js(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
  await capture('10-detail-failed', { full: true, note: 'Failed (authentication) with technical details open' });
  await axTree('detail-failed');
  await click('[data-action="back"]');
  await heading('History');
  await openJob('unconfirmed');
  await js(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
  await capture('11-detail-unconfirmed', { full: true, note: 'Unconfirmed delivery with last check time' });
  await click('[data-action="back"]');
  await openJob('sent-late');
  await capture('12-detail-sent-late', { full: true, note: 'Sent after a 45 minute catch-up delay' });
  await click('[data-action="back"]');
  await openJob('canceled-activity');
  await capture('13-detail-canceled-activity', { full: true, note: 'Canceled automatically because of new user activity' });
  await click('[data-action="back"]');
  await openJob('legacy');
  await capture('14-detail-legacy', { full: true, note: 'Legacy record without timezone or thread title' });

  // Threads
  await go('threads', 'Threads');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="t-sched"]'))`), 'threads');
  await capture('15-threads', { note: 'Threads with settled hidden' });
  await click('#show-settled');
  await capture('16-threads-show-settled', { full: true, note: 'All non-archived threads including long, untitled, unknown and missing time' });
  await axTree('threads');
  await click('#show-settled');

  // Composer
  await click('[data-action="new"]');
  await heading('New schedule');
  await capture('17-composer-new', { full: true, note: 'New schedule, no thread chosen' });
  await axTree('composer');
  await js('document.activeElement?.blur(); window.scrollTo(0,0)');
  report.tabOrders.push(await tabOrder('composer', 16));
  report.checks.composerValidity = await js(`(() => { const f=document.querySelector('#schedule-form'); return [...f.elements].filter(e=>e.willValidate).map(e=>({id:e.id||e.name||e.tagName, valid:e.validity.valid, message:e.validationMessage})); })()`);
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await capture('18-composer-error-no-thread', { full: true, note: 'Submit without a thread' });
  await click('[data-action="pick"]');
  await heading('Choose a thread');
  await capture('19-composer-thread-picker', { note: 'Thread picker inside the composer' });
  await click('[data-thread="t-checkout"]');
  await heading('New schedule');
  await fill('#date', '2020-01-01');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await capture('20-composer-error-past', { full: true, note: 'Past date error' });
  await fill('#date', '2026-2-3');
  report.checks.nativePatternBlocksSubmit = await js(`(() => { const f=document.querySelector('#schedule-form'); const d=document.querySelector('#date'); return {formValid:f.checkValidity(), message:d.validationMessage}; })()`);
  await fill('#timezone', 'Europe/London');
  await fill('#date', '2027-03-28');
  await fill('#time', '01:30');
  await capture('21-composer-dst-gap', { full: true, note: 'Daylight-saving gap preview' });
  await fill('#date', '2026-10-25');
  await capture('22-composer-dst-ambiguous', { full: true, note: 'Ambiguous repeated hour asks for an offset' });
  await fill('#timezone', 'Mars/Olympus');
  await capture('23-composer-bad-timezone', { full: true, note: 'Unknown timezone' });
  await fill('#timezone', 'Europe/London');
  await fill('#date', new Date(NOW + 2 * 86400000).toISOString().slice(0, 10));
  await fill('#time', '09:00');
  await click('[data-action="calendar"]');
  await capture('24-composer-calendar', { full: true, note: 'Calendar open, focus on chosen day' });
  await key('ArrowRight');
  await key('ArrowDown');
  await capture('25-composer-calendar-keyboard', { full: true, note: 'Calendar after ArrowRight, ArrowDown' });
  report.checks.calendarEscapeCloses = await (async () => { await key('Escape'); return js(`!document.querySelector('#calendar')`); })();
  await click('[data-action="calendar"]').catch(() => {});
  await fill('#message', '');
  report.checks.emptyMessageNative = await js(`document.querySelector('#message').validationMessage`);
  await fill('#message', 'Continue');

  // Settings
  await go('settings', 'Settings');
  await capture('26-settings', { full: true, note: 'Settings' });
  await axTree('settings');
  await js('document.activeElement?.blur(); window.scrollTo(0,0)');
  report.tabOrders.push(await tabOrder('settings', 12));
  await fill('#port', '70000');
  report.checks.settingsPortNative = await js(`(() => ({formValid:document.querySelector('#settings-form').checkValidity(), message:document.querySelector('#port').validationMessage}))()`);
  await fill('#port', '3773');
  await click('[data-action="check"]');
  await waitFor(() => js(`!document.querySelector('#toast').hidden`), 'toast');
  await capture('27-toast-connected', { note: 'Success toast after Check connection' });
  await js(`document.querySelector('#toast-dismiss').click()`);

  // Sending then failure toast.
  await go('upcoming', 'Upcoming');
  const due = timers.find((timer) => !timer.canceled && timer.when.valueOf() <= Date.now() + 1000);
  due.callback();
  await waitFor(() => Boolean(heldPost), 'dispatch held');
  await delay(300);
  await capture('28-upcoming-sending', { note: 'A job in Sending state' });
  await openJob('due');
  await capture('29-detail-sending', { full: true, note: 'Sending detail' });
  heldPost();
  await waitFor(() => js(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('failed')`), 'failure toast');
  await capture('30-toast-failure', { full: true, note: 'Failure toast with View while on the detail page' });
  await click('[data-action="back"]');
  await heading('Upcoming');
  await capture('31-upcoming-after-failure', { note: 'Back on Upcoming after the failure' });

  // ---- Dark theme subset ----
  await setTheme('dark');
  await go('upcoming', 'Upcoming');
  await capture('01-upcoming');
  await go('history', 'History');
  await capture('08-history');
  await openJob('failed-auth');
  await js(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
  await capture('10-detail-failed', { full: true });
  await go('threads', 'Threads');
  await capture('15-threads');
  await click('[data-action="new"]');
  await heading('New schedule');
  await click('[data-action="calendar"]');
  await capture('24-composer-calendar', { full: true });
  await js('document.activeElement?.blur(); window.scrollTo(0,0)');
  await tabOrder('dark-composer', 3);
  await capture('17b-composer-keyboard-focus', { note: 'Dark focus ring on a quick-time chip' });
  await go('settings', 'Settings');
  await capture('26-settings', { full: true });
  await click('[data-action="check"]');
  await waitFor(() => js(`!document.querySelector('#toast').hidden`), 'toast');
  await capture('27-toast-connected');
  await js(`document.querySelector('#toast-dismiss').click()`);

  // ---- Narrow widths ----
  for (const [w, themes] of [[620, ['light', 'dark']], [420, ['light', 'dark']], [375, ['light']]]) {
    await size(w, 760);
    for (const t of themes) {
      await setTheme(t);
      await go('upcoming', 'Upcoming');
      await capture('01-upcoming');
      await go('history', 'History');
      await capture('08-history');
      await openJob('failed-auth');
      await capture('10-detail-failed', { full: true });
      await go('threads', 'Threads');
      await capture('15-threads');
      await click('[data-action="new"]');
      await heading('New schedule');
      await click('[data-action="calendar"]');
      await capture('24-composer-calendar', { full: true });
      await go('settings', 'Settings');
      await capture('26-settings', { full: true });
    }
  }

  // ---- Offline: HTML response, then connection refused ----
  await size(1180, 800);
  await setTheme('light');
  apiMode = 'html';
  await go('threads', 'Threads');
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('Offline')`), 'offline');
  await delay(200);
  await capture('32-threads-offline-html', { note: 'Offline because T3 Code returned HTML' });
  await go('upcoming', 'Upcoming');
  await capture('33-upcoming-offline-html', { note: 'Queue while offline' });
  await click('[data-action="new"]');
  await heading('New schedule');
  await capture('34-composer-offline', { full: true, note: 'Composer while offline' });
  apiMode = 'refused';
  await click('[data-action="back"]');
  await click('[data-action="check"]');
  await delay(300);
  await js(`document.querySelectorAll('details').forEach(d=>d.open=true)`);
  await capture('35-upcoming-offline-refused', { note: 'Connection refused with technical details open' });
  await setTheme('dark');
  await capture('35-upcoming-offline-refused');
  await size(420, 760);
  await capture('35-upcoming-offline-refused');
  await setTheme('light');
  await capture('35-upcoming-offline-refused');
  await size(1180, 800);

  // Reduced motion and forced colours signal checks.
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await go('settings', 'Settings');
  report.checks.reducedMotionStarAnimation = await js(`getComputedStyle(document.querySelector('.star svg')).animationName`);
  report.checks.reducedMotionButtonTransition = await js(`getComputedStyle(document.querySelector('button')).transitionDuration`);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  report.checks.fonts = await js(`[...new Set([...document.querySelectorAll('h1,h2,button,p')].map(e=>getComputedStyle(e).fontFamily))]`);
  report.checks.posts = posts.length;
  fs.writeFileSync(path.join(dataOut, 'report.json'), JSON.stringify(report, null, 2));
}

async function simpleTour() {
  await delay(900);
  if (scenario === 'no-token') {
    await heading('Settings');
    await delay(400);
    await capture('settings', { full: true, note: 'First launch without a token opens Settings' });
    await go('upcoming', 'Upcoming');
    await delay(400);
    await capture('upcoming', { note: 'Upcoming without a token' });
    return;
  }
  await capture('upcoming', { note: `Upcoming (${scenario})` });
  await go('threads', 'Threads');
  await capture('threads', { note: `Threads (${scenario})` });
  if (scenario === 'loading') {
    await click('[data-action="new"]');
    await heading('New schedule');
    await click('[data-action="pick"]');
    await capture('composer-picker', { note: 'Thread picker while the first connection is pending' });
    return;
  }
  await go('history', 'History');
  await capture('history', { note: `History (${scenario})` });
  if (scenario === 'empty') {
    await setTheme('dark');
    await go('upcoming', 'Upcoming');
    await capture('upcoming');
    await size(420, 760);
    await capture('upcoming');
  }
  if (scenario === 'storage') {
    await click('[data-action="new"]');
    await heading('New schedule');
    await capture('composer', { full: true, note: 'Composer while storage is broken' });
  }
}

async function run() {
  await app.whenReady();
  app.dock?.hide();
  loadProductionMain();
  await waitFor(() => windows.length === 1 && !windows[0].webContents.isLoading(), 'window loaded');
  win = windows[0];
  win.setContentSize(width, height);
  win.webContents.debugger.attach('1.3');
  cdp = (method, params) => win.webContents.debugger.sendCommand(method, params);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  js = (code) => win.webContents.executeJavaScript(code, true);
  await waitFor(() => js('Boolean(window.autoContinue && document.querySelector("main"))'), 'renderer');
  await setTheme('light');
  if (scenario === 'populated') await populatedTour(); else await simpleTour();
  const indexFile = path.join(dataOut, `index-${scenario}.json`);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  assert.equal(posts.length <= 1, true, 'Only the held fixture POST may occur');
  console.log(`Captured ${index.length} screenshots for ${scenario} into ${path.relative(root, out)}`);
}
run().then(() => app.exit(0), (error) => { console.error(error.stack); app.exit(1); });
