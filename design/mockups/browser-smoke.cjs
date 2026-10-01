'use strict';
// Focused browser test for the standalone feature prototypes. No npm dependencies.
// CHROME_BIN=/path/to/chrome node design/mockups/browser-smoke.cjs /absolute/evidence/dir
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const out = path.resolve(process.argv[2]);
const profile = fs.mkdtempSync(path.join(process.cwd(), '.prototype-test-'));
const chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
const observations = [];
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await delay(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const [ok, bad] = pending.get(m.id); pending.delete(m.id); m.error ? bad(Error(JSON.stringify(m.error))) : ok(m.result); } };
  const send = (method, params = {}) => new Promise((ok, bad) => { const id = ++seq; pending.set(id, [ok, bad]); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).innerText`);
  const navigate = async query => {
    await send('Page.navigate', { url: pathToFileURL(path.join(__dirname, 'index.html')).href + '?' + query });
    for (let i = 0; i < 100; i++) { await delay(50); if (await evaluate(`location.search === ${JSON.stringify('?' + query)} && document.readyState === 'complete' && !!document.querySelector('.studio')`)) break; }
    await evaluate('document.fonts.ready.then(() => true)');
  };
  const capture = async name => {
    const metrics = await send('Page.getLayoutMetrics');
    const size = metrics.cssContentSize;
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const record = async name => observations.push({ name, plan: await text('#plan .sentence'), button: await text('[data-action=submit]') });
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false });
  await navigate('concept=board&view=compose&composer=presets');
  for (const preset of ['time-once', 'free-once', 'free-done']) {
    await click(`input[name=preset][value=${preset}]`);
    const plan = await text('#plan .sentence');
    assert.match(plan, preset === 'time-once' ? /At 2026-10-01 06:30.*once/ : preset === 'free-once' ? /When Claude Code is free.*once/ : /keep going until Claude Code says it is done/);
    assert.equal(await text('[data-action=submit]'), preset === 'time-once' ? 'Schedule for 06:30' : 'Start when Claude Code is free');
    await record(preset);
  }
  await click('input[name=preset][value=time-once]');
  await input('#date', '2026-10-02'); await input('#time', '08:15');
  assert.match(await text('#plan .sentence'), /2026-10-02 08:15/);
  assert.equal(await text('[data-action=submit]'), 'Schedule for 08:15');
  await record('edited date and time'); await capture('composer-time');
  await click('[data-nav=picker]'); await click('[data-thread=th-export]');
  await click('input[name=preset][value=free-done]');
  assert.match(await text('#plan .sentence'), /Right away, because Codex CLI is free now/);
  assert.equal(await text('[data-action=submit]'), 'Start now');
  await record('free agent starts now'); await capture('composer-start-now');
  await click('[data-action=submit]');
  assert.match(await text('[role=status]'), /Task saved in this prototype. Nothing is sent/);
  await navigate('concept=board&view=compose');
  for (const thread of ['th-pricing', 'th-onboard']) {
    await click('[data-nav=picker]'); await click(`[data-thread=${thread}]`);
    assert.equal(await evaluate('document.querySelector("input[name=far][value=done]").disabled'), true);
    assert.equal(await evaluate('document.querySelector("input[name=far][value=turns]").checked'), true);
  }
  await capture('composer-desktop');
  await click('[data-nav=picker]'); await click('[data-thread=th-sched]');
  await click('input[name=far][value=done]'); await input('#max', '');
  assert.equal(await evaluate('document.querySelector("#max").getAttribute("aria-invalid")'), 'true');
  assert.match(await text('#turns-error'), /Set a turn limit: T3 Code/);
  await click('[data-action=submit]');
  assert.equal(await evaluate('document.activeElement.id'), 'max');
  await capture('composer-required-limit');
  await input('#max', '4');
  assert.match(await text('#plan .sentence'), /at most 4 turns/);
  await click('input[name=far][value=turns]'); await input('#turns', '0');
  assert.equal(await evaluate('document.querySelector("#turns").getAttribute("aria-invalid")'), 'true');
  await click('[data-action=submit]');
  assert.equal(await evaluate('document.activeElement.id'), 'turns');
  assert.match(await text('#turns-error'), /Use at least 1 turn/);
  await capture('composer-zero-rejected');
  await input('#turns', '1'); await click('[data-action=submit]');
  assert.match(await text('[role=status]'), /Task saved/);
  await navigate('concept=board&scenario=morning');
  const morning = await text('main');
  assert.match(morning, /2 need you · 0 running · 2 waiting/);
  assert.match(morning, /3 tasks finished, 19 turns ran, 2 need you/);
  assert.match(morning, /Checking again at 07:05/);
  assert.doesNotMatch(morning, /Shift|Checking again at 22:45|\u2014/);
  assert.equal(await evaluate('document.querySelectorAll(".tally").length'), 0);
  observations.push({ name: 'next morning', renderedReport: morning });
  await capture('board-next-morning');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await navigate('concept=board&view=compose&theme=dark');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await capture('composer-420-dark');
  fs.writeFileSync(path.join(out, 'interaction-transcript.json'), JSON.stringify(observations, null, 2));
  console.log('Prototype controls, validation, save feedback, morning report, and narrow layout passed.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (ws) ws.close();
  chrome.kill('SIGTERM');
  await new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  fs.rmSync(profile, { recursive: true, force: true });
});
