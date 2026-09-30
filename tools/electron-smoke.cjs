'use strict';
// Executes the production main process, preload and renderer against in-memory
// storage and an injected API. No network request or scheduled POST can occur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const electron = require('electron');
const { app, BrowserWindow } = electron;
// Chromium storage is isolated too; even theme/localStorage cannot touch user state.
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 't3-scheduler-smoke-'));
app.setPath('userData', profile);
const root = path.resolve(__dirname, '..');
const files = new Map();
const windows = [];
const failures = [];
let offline = false;
let dispatches = 0;
const externalUrls = [];
let menu;
const evidenceDirectory = process.env.T3_SMOKE_EVIDENCE_DIR;
async function capture(name) {
  if (!evidenceDirectory) return;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  // Give Chromium a frame to paint the latest state before capturing pixels.
  await new Promise(resolve => setTimeout(resolve, 150));
  const screenshot = await windows[0].webContents.capturePage();
  assert.equal(screenshot.isEmpty(), false, 'Rendered evidence must contain pixels');
  fs.writeFileSync(path.join(evidenceDirectory, `${name}.png`), screenshot.toPNG());
}
const fixtureThread = { id: 'thread-active', title: 'Production renderer test', projectId: 'project-fixture', updatedAt: '2026-09-30T12:34:56.789Z', settledOverride: null, messages: [], modelSelection: { model: 'fixture', instanceId: 'fixture' }, runtimeMode: 'full-access', interactionMode: 'default' };
const jobs = [{ id: 'failure-fixture', commandId: 'command-fixture', messageId: 'message-fixture', threadId: fixtureThread.id, threadTitle: fixtureThread.title, message: 'Previous failed delivery', scheduleAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-01T10:00:00Z', status: 'failed', note: 'Unexpected token <', bufferSeconds: 5, timeZone: 'UTC' }];
jobs.push({ ...jobs[0], id: 'uncertain-fixture', messageId: 'uncertain-message', status: 'unconfirmed', message: 'Unconfirmed fixture delivery' });
files.set('/fixture/jobs.json', JSON.stringify(jobs));
const fakeFs = {
  readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' }); return files.get(name); },
  mkdirSync() {}, writeFileSync(name, value) { files.set(name, value); },
  renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
};
async function fixtureFetch(url, options = {}) {
  if (options.method === 'POST') { dispatches++; throw new Error('Dispatch is prohibited in the smoke fixture.'); }
  if (offline) return new Response('<!doctype html><html>Fixture outage</html>', { headers: { 'content-type': 'text/html' } });
  const payload = url.includes('/threads/') ? { snapshotSequence: 1, thread: fixtureThread } : {
    snapshotSequence: 1,
    projects: [{ id: 'project-fixture', title: 'Fixture project' }],
    threads: [fixtureThread, { ...fixtureThread, id: 'thread-settled', title: 'Settled fixture', settledOverride: 'settled' }]
  };
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}
const apiModule = require('../lib/api-client');
const appProxy = new Proxy(app, { get(target, property) {
  if (property === 'requestSingleInstanceLock') return () => true;
  if (property === 'getPath') return name => name === 'userData' ? '/fixture' : target.getPath(name);
  const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
} });
class FixtureWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, show: false });
    windows.push(this);
    this.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    this.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer stopped: ${detail.reason}`));
    this.webContents.on('did-fail-load', (_event, code, description) => failures.push(`Load failed ${code}: ${description}`));
  }
  show() { /* Keep executable tests out of the user's foreground. */ }
  focus() { /* Keep executable tests out of the user's foreground. */ }
}
const injectedElectron = {
  ...electron, app: appProxy, BrowserWindow: FixtureWindow,
  Tray: class { setToolTip() {} on() {} setContextMenu(value) { menu = value; } },
  Menu: { buildFromTemplate: value => value }, Notification: { isSupported: () => false },
  shell: { openExternal: async url => { externalUrls.push(url); } },
  powerMonitor: { on() {} }
};
function loadProductionMain() {
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(name) {
      if (name === 'electron') return injectedElectron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node-schedule') return { scheduleJob: () => ({ cancel() {} }) };
      if (name === './lib/api-client') return { ...apiModule, createApiClient: options => apiModule.createApiClient({ ...options, fetchImpl: fixtureFetch }) };
      return name.startsWith('./lib/') ? require(path.join(root, name)) : require(name);
    }, __dirname: root, process: { env: { T3_TOKEN: 'fixture-only' }, pid: process.pid }, console, Buffer
  }, { filename: 'main.js' });
}
async function waitFor(check, label) {
  const deadline = Date.now() + 10_000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  await app.whenReady();
  app.dock?.hide();
  loadProductionMain();
  await waitFor(() => windows.length === 1 && !windows[0].webContents.isLoading(), 'production window loaded');
  const window = windows[0];
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const js = code => window.webContents.executeJavaScript(code, true);
  await waitFor(() => js('Boolean(window.autoContinue && document.querySelector("main"))'), 'production renderer initialized');
  await js(`(() => { if (document.body.classList.contains('dark')) document.querySelector('[data-action="theme"]').click(); })()`);
  assert.equal(windows.length, 1);
  assert.equal((await js('window.autoContinue.listJobs({view:"history"})')).total, 2);
  await js('window.autoContinue.openSettings()');
  await waitFor(() => js('document.body.innerText.includes("Settings")'), 'settings route');
  await js('window.autoContinue.scheduleThread("thread-active")');
  assert.equal(windows.length, 1);
  // DOM journey assertions are maintained below with the production selectors.
  await rendererJourney(js);
  offline = true;
  const history = await js('window.autoContinue.listJobs({view:"history"})');
  assert.ok(history.total >= 1, 'History survives offline API');
  const connection = await js('window.autoContinue.checkConnection()');
  assert.equal(connection.error.code, 'unexpected_response_format');
  await js(`document.querySelector('[data-nav="threads"]').click()`);
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('Offline')`), 'visible offline state');
  await js(`document.querySelector('[data-nav="history"]').click()`);
  await capture('history-offline');
  offline = false;
  await js(`document.querySelector('[data-nav="threads"]').click()`);
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('connected')`), 'connection recovery clears current failure');
  assert.equal(await js(`document.querySelector('#notices').textContent.includes('unexpected')`), false);
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'persisted-fixture-jobs.json'), files.get('/fixture/jobs.json'));
  assert.equal(dispatches, 0, 'The fixture must never send a message');
  assert.deepEqual(failures, []);
  assert.ok(menu.find(item => item.label === 'Open scheduler'));
  console.log('Electron production workflow smoke passed: one window, real preload/IPC/renderer, local history, sanitized offline error, zero sends.');
}
async function rendererJourney(js) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = async (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const heading = expected => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
  await heading('New schedule');
  await fill('#message', 'Fixture message from the production composer');
  await fill('#date', '2099-02-30');
  await fill('#time', '12:00');
  await fill('#timezone', 'UTC');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  assert.match(await js(`document.querySelector('#schedule-error').textContent`), /real calendar/);
  await fill('#date', '2099-12-15');
  await click('[data-action="calendar"]');
  await capture('composer-calendar');
  await click('[data-action="calendar"]');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  const created = await js(`window.autoContinue.listJobs({view:'upcoming'}).then(result=>result.jobs.find(job=>job.message==='Fixture message from the production composer'))`);
  assert.ok(created);
  assert.equal(created.timeZone, 'UTC');
  assert.equal(created.scheduleAt, '2099-12-15T12:00:00.000Z');
  assert.equal(created.effectiveAt, '2099-12-15T12:00:05.000Z');
  await capture('upcoming-scheduled');
  await click(`[data-job="${created.id}"]`);
  await click('[data-action="edit"]');
  await heading('Edit schedule');
  await fill('#message', 'Fixture message edited');
  await fill('#time', '14:00');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(created.id)})`)).message, 'Fixture message edited');
  await click(`[data-job="${created.id}"]`);
  await click('[data-action="cancel"]');
  await click('[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(created.id)}).then(job=>job.status==='canceled')`), 'canceled schedule persisted');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'canceled detail refreshed');
  await click('[data-nav="history"]');
  await heading('History');
  await click('[data-job="failure-fixture"]');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  assert.equal(await js(`document.querySelector('.detail-header .pill').textContent`), 'Delivery unconfirmed');
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'legacy reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'legacy reconciliation completed');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  await click('[data-action="ack"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.acknowledgedAt))`), 'acknowledgment persisted');
  await waitFor(() => js(`document.querySelector('[data-action="ack"]')?.textContent.includes('Acknowledged')`), 'acknowledged UI');
  await capture('history-acknowledged');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 1);
  await click('[data-nav="history"]');
  await click('[data-job="uncertain-fixture"]');
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'first reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'first reconciliation completed');
  assert.equal((await js(`window.autoContinue.getJob('uncertain-fixture')`)).status, 'unconfirmed');
  fixtureThread.messages.push({ id: 'uncertain-message', role: 'user', createdAt: '2026-01-01T10:00:00Z' });
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>job.status==='sent')`), 'existing message confirmed without resend');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'confirmed detail refreshed');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 0);
  await click('[data-nav="threads"]');
  await heading('Threads');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="thread-active"]'))`), 'thread data loaded');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), false);
  await js(`document.querySelector('[data-thread="thread-active"]').focus()`);
  const exactTime = await js(`(() => {
    const row = document.activeElement;
    const exact = row.querySelector('time');
    const short = row.querySelector('.thread-time-short');
    return { thread: row.dataset.thread, text: exact.textContent, datetime: exact.dateTime,
      visible: exact.getBoundingClientRect().width > 1 && getComputedStyle(exact).clipPath === 'none',
      shortHidden: getComputedStyle(short).display === 'none', relative: row.querySelector('[data-relative]').textContent };
  })()`);
  assert.equal(exactTime.thread, 'thread-active');
  assert.equal(exactTime.text, fixtureThread.updatedAt);
  assert.equal(exactTime.datetime, fixtureThread.updatedAt);
  assert.equal(exactTime.visible, true, JSON.stringify(exactTime));
  assert.equal(exactTime.shortHidden, true);
  assert.ok(exactTime.relative.length > 0);
  await capture('threads-exact-time');
  await click('#show-settled');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), true);
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#settings-form'))`), 'settings loaded');
  await supportStarJourney(js, click);
  await click('[data-action="support"]');
  await waitFor(() => externalUrls.length === 1, 'support page opened in browser');
  assert.deepEqual(externalUrls, ['https://ko-fi.com/velvetacorn']);
  await waitFor(() => js(`!document.querySelector('[data-action="support"]').disabled`), 'support operation finished');
  assert.ok(windows[0].webContents.getURL().startsWith('file:'), 'Support must leave the app on its local page');
  await fill('#buffer', '12');
  await js(`document.querySelector('#settings-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.bufferSeconds===12)`), 'settings saved');
  await waitFor(() => js(`!document.querySelector('#buffer').disabled`), 'settings operation finished');
  await js(`(() => { const select=document.querySelector('#theme'); select.value='dark'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await js(`document.body.classList.contains('dark')`), true);
  assert.equal(await js(`document.querySelector('[data-action="support"]').disabled`), false);
  assert.equal(await js(`Boolean(document.querySelector('.star svg'))`), true);
  await capture('settings-bone-outline');
  await js(`document.querySelector('.support').scrollIntoView({block:'center'})`);
  await capture('settings-support');
  // A settings change must be reflected in the next draft's send preview.
  await click('[data-nav="upcoming"]');
  await click('[data-action="new"]');
  assert.match(await js(`document.querySelector('#schedule-preview').textContent`), /12-second/);
  assert.equal(windows.length, 1, 'Every journey stayed in the same window');
}
async function supportStarJourney(js, click) {
  const phrase = () => js(`document.querySelector('#star-phrase').textContent`);
  const phrases = await js('window.SupportStar.STICKER_PHRASES');
  const star = await js(`(() => { const star=document.querySelector('#support-star'); return { tag: star.tagName, name: star.getAttribute('aria-label'), described: star.getAttribute('aria-describedby'), lines: star.querySelectorAll('.star-text span').length, fit: star.querySelector('.star-text').style.getPropertyValue('--fit') }; })()`);
  assert.deepEqual({ ...star, fit: Number(star.fit) > 0 }, { tag: 'BUTTON', name: 'Shuffle sticker phrase', described: 'star-phrase', lines: star.lines, fit: true });
  assert.ok(star.lines >= 1 && phrases.includes(await phrase()));
  // Re-renders keep the phrase; leaving and re-entering Settings picks a different one.
  const entered = await phrase();
  await js(`document.querySelector('[data-action="theme"]').click()`);
  await js(`document.querySelector('[data-action="theme"]').click()`);
  assert.equal(await phrase(), entered);
  await click('[data-nav="upcoming"]');
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#support-star'))`), 'settings re-entered');
  assert.notEqual(await phrase(), entered);
  // Every phrase's glyphs stay inside the outline's inner edge (0.361 of the width) and the text never rotates.
  const fit = await js(`(async () => {
    const star = document.querySelector('#support-star'), seen = new Map();
    for (let attempt = 0; attempt < 500 && seen.size < window.SupportStar.STICKER_PHRASES.length; attempt++) {
      star.click();
      const text = star.querySelector('.star-text'), style = getComputedStyle(text), size = parseFloat(style.fontSize), lineHeight = parseFloat(style.lineHeight);
      const context = document.createElement('canvas').getContext('2d'); context.font = '900 ' + size + 'px Georgia, serif';
      const box = star.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      let worst = 0;
      for (const line of text.querySelectorAll('span')) {
        const rect = line.getBoundingClientRect(), metrics = context.measureText(line.textContent);
        const baseline = rect.top + (lineHeight - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
        for (const x of [rect.left - metrics.actualBoundingBoxLeft, rect.left + metrics.actualBoundingBoxRight]) for (const y of [baseline - metrics.actualBoundingBoxAscent, baseline + metrics.actualBoundingBoxDescent]) worst = Math.max(worst, Math.hypot(x - cx, y - cy) / box.width);
      }
      seen.set(star.querySelector('#star-phrase').textContent, { worst, size, rotated: style.transform !== 'none' });
    }
    return Object.fromEntries(seen);
  })()`);
  assert.deepEqual(Object.keys(fit).sort(), [...phrases].sort());
  for (const [text, result] of Object.entries(fit)) assert.ok(result.worst < 0.355 && result.size >= 10 && !result.rotated, `${text}: ${JSON.stringify(result)}`);
  // A click bursts and eases back without the angle ever jumping or reversing, even across a re-render.
  const motion = await js(`new Promise(resolve => {
    const angle = () => parseFloat(document.querySelector('#support-star polygon').style.transform.slice(7));
    const samples = [], start = performance.now(), before = document.querySelector('#star-phrase').textContent;
    document.querySelector('#support-star').click();
    setTimeout(() => document.querySelector('[data-action="theme"]').click(), 300);
    (function frame(now) { samples.push([now, angle()]); if (now - start < 1400) requestAnimationFrame(frame); else resolve({ samples, changed: document.querySelector('#star-phrase').textContent !== before, status: document.querySelector('#star-status').textContent }); })(start);
  })`);
  await js(`document.querySelector('[data-action="theme"]').click()`);
  assert.equal(motion.changed, true);
  const steps = motion.samples.slice(1).map(([time, angle], index) => ({ elapsed: time - motion.samples[index][0], turned: (angle - motion.samples[index][1] + 360) % 360 }));
  assert.ok(steps.length > 20, 'the star animates frame by frame');
  for (const step of steps) assert.ok(step.turned <= 480 * Math.max(step.elapsed, 17) / 1000 + 0.5, `angle jumped ${JSON.stringify(step)}`);
  assert.ok(Math.max(...steps.map(step => step.turned / Math.max(step.elapsed, 1) * 1000)) > 200, 'the click produced a fast burst');
  // Reduced motion: no spin or burst, but a click still changes the phrase.
  await click('#motion');
  const still = await js(`new Promise(resolve => { const angle = () => document.querySelector('#support-star polygon').style.transform, first = angle(), before = document.querySelector('#star-phrase').textContent; document.querySelector('#support-star').click(); setTimeout(() => resolve({ moved: angle() !== first, changed: document.querySelector('#star-phrase').textContent !== before }), 400); })`);
  assert.deepEqual(still, { moved: false, changed: true });
  await click('#motion');
}
run().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
