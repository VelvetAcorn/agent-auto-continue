'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCompatibilityMonitor } = require('../lib/compatibility-monitor');
const { createDiagnosticsLog, MAX_ENTRIES } = require('../lib/diagnostics');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { appVersionUnsupported, toErrorInfo } = require('../lib/harnesses/errors');
const { JobService } = require('../lib/job-service');
const { createFakeHarness } = require('../tools/fake-harness.cjs');

const UI = ['content_match', 'composer_label', 'send_label'];
const passing = (version = '2.0') => ({ depth }) => ({ appVersion: version, verifiedVersion: '1.0', problems: [], checked: depth === 'quick' ? ['app_path', 'deep_link'] : ['app_path', 'deep_link', ...UI], unchecked: [] });
const broken = (version = '2.0') => ({ depth }) => depth === 'quick' ? passing(version)({ depth }) : {
  appVersion: version, verifiedVersion: '1.0', checked: ['app_path', 'deep_link', 'content_match'], unchecked: [{ contactPoint: 'send_label', reason: 'no_composer' }],
  problems: [{ contactPoint: 'composer_label', message: `Desk App ${version} changed how its message box is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.`, hint: 'No text area labelled "Prompt".' }]
};

function setup({ compatibility = passing(), stored = null, scheduled = () => false } = {}) {
  let clock = Date.parse('2026-10-01T09:00:00Z');
  const fake = createFakeHarness({ id: 'desk', label: 'Desk App', kind: 'desktop-app', compatibility, conversations: [{ id: 'c1', title: 'One' }] });
  const plain = createFakeHarness({ id: 'plain', label: 'Plain' });
  const harnesses = createHarnessRegistry([fake.adapter, plain.adapter]);
  const files = { compatibility: stored, diagnostics: null };
  const events = { changes: 0, problems: [] };
  const diagnostics = createDiagnosticsLog({ load: () => files.diagnostics, save: (value) => { files.diagnostics = JSON.parse(JSON.stringify(value)); }, now: () => clock });
  const monitor = createCompatibilityMonitor({ harnesses, diagnostics, now: () => clock, hasScheduledWork: scheduled,
    load: () => files.compatibility, save: (value) => { files.compatibility = JSON.parse(JSON.stringify(value)); },
    onChange: () => { events.changes += 1; }, onProblem: (id, problems) => events.problems.push([id, problems.map((item) => item.contactPoint)]) });
  const depths = () => fake.state.calls.filter((call) => call[0] === 'checkCompatibility').map((call) => call[1].depth);
  return { fake, harnesses, monitor, diagnostics, files, events, depths, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('startup runs a quick check, and a full one only with scheduled work or a version that has not passed', async () => {
  const idle = setup();
  await idle.monitor.startup();
  assert.deepEqual(idle.depths(), ['quick'], 'An app nobody schedules for is not inspected');
  const busy = setup({ scheduled: (id) => id === 'desk' });
  await busy.monitor.startup();
  assert.deepEqual(busy.depths(), ['quick', 'full']);
  const updated = setup({ stored: { version: 1, harnesses: { desk: { lastPassing: { appVersion: '1.9', checkedAt: '2026-09-01T00:00:00Z' }, problems: [] } } } });
  await updated.monitor.startup();
  assert.deepEqual(updated.depths(), ['quick', 'full'], 'A new app version is checked at once');
  assert.deepEqual(updated.files.compatibility.harnesses.desk.lastPassing.appVersion, '2.0', 'The new version passed and is remembered');
});

test('a problem is logged once, marks scheduled work at risk, and clears when a later check proves it works', async () => {
  const { fake, monitor, diagnostics, events, files } = setup({ compatibility: broken() });
  await monitor.check('desk');
  assert.deepEqual(events.problems, [['desk', ['composer_label']]]);
  const [state] = monitor.snapshot();
  assert.deepEqual([state.ok, state.appVersion, state.lastPassing, state.problems[0].source], [false, '2.0', null, 'check']);
  assert.match(monitor.riskFor('desk').message, /^Desk App 2\.0 changed how its message box is labelled/);
  assert.equal(monitor.riskFor('plain'), null);
  await monitor.check('desk');
  assert.equal(events.problems.length, 1, 'The same problem is announced once');
  assert.deepEqual(diagnostics.list().map((item) => [item.source, item.harness, item.app, item.appVersion, item.contactPoint, item.count]), [['check', 'desk', 'Desk App', '2.0', 'composer_label', 2]]);
  await monitor.check('desk', { depth: 'quick' });
  assert.equal(monitor.snapshot()[0].ok, false, 'A quick check cannot clear an interface problem');
  fake.state.compatibility = passing();
  await monitor.check('desk');
  assert.deepEqual([monitor.snapshot()[0].ok, monitor.riskFor('desk')], [true, null]);
  assert.equal(files.compatibility.harnesses.desk.lastPassing.appVersion, '2.0');
});

test('problems survive a restart, and a different app version starts fresh', async () => {
  const first = setup({ compatibility: broken('2.0') });
  await first.monitor.check('desk');
  const restarted = setup({ compatibility: broken('2.1'), stored: first.files.compatibility });
  assert.equal(restarted.monitor.riskFor('desk').appVersion, '2.0');
  restarted.fake.state.compatibility = ({ depth }) => ({ ...passing('2.1')({ depth: 'quick' }), depth });
  await restarted.monitor.check('desk', { depth: 'quick' });
  assert.equal(restarted.monitor.riskFor('desk'), null, 'The 2.0 problem says nothing about 2.1');
});

test('tick checks only harnesses with scheduled work, and runs a full check when it is due', async () => {
  let scheduled = false;
  const { fake, monitor, depths, advance } = setup({ scheduled: () => scheduled });
  await monitor.tick();
  assert.deepEqual(depths(), []);
  scheduled = true;
  await monitor.tick();
  assert.deepEqual(depths(), ['quick', 'full'], 'Never fully checked before');
  advance(10 * 60_000);
  await monitor.tick();
  assert.deepEqual(depths(), ['quick', 'full', 'quick']);
  fake.state.compatibility = passing('2.1');
  await monitor.tick();
  assert.deepEqual(depths().slice(3), ['quick', 'full'], 'An app update is fully checked at once');
  advance(61 * 60_000);
  await monitor.tick();
  assert.deepEqual(depths().slice(5), ['quick', 'full'], 'Hourly while work is scheduled');
});

// A full check that cannot see the app's interface, for example because no conversation is shown.
const blind = ({ depth }) => ({ appVersion: '2.0', verifiedVersion: '1.0', problems: [], checked: ['app_path', 'deep_link'], unchecked: UI.map((contactPoint) => ({ contactPoint, reason: depth === 'quick' ? 'quick' : 'no_conversation_shown' })) });

test('delivery outcomes feed the monitor: a drift failure is a problem until a check or a send proves otherwise', async () => {
  const { fake, monitor, diagnostics, events, depths } = setup({ compatibility: blind });
  const error = toErrorInfo(appVersionUnsupported({ app: 'Desk App', appVersion: '2.0', verifiedVersion: '1.0', contactPoint: 'send_label', hint: 'No button labelled "Send".' }));
  monitor.observe({ harness: 'desk', jobId: 'job-1', status: 'failed', error });
  assert.deepEqual(events.problems, [['desk', ['send_label']]]);
  const [state] = monitor.snapshot();
  assert.equal(state.problems[0].source, 'delivery');
  assert.equal(state.problems[0].message, 'Desk App 2.0 changed how its send button is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.');
  assert.deepEqual(diagnostics.list().map((item) => [item.source, item.jobId, item.code, item.contactPoint]), [['delivery', 'job-1', 'app_version_unsupported', 'send_label']]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(depths(), ['full'], 'A follow-up check runs right away');
  // The follow-up check could not see the interface, so the delivery problem stands.
  monitor.observe({ harness: 'desk', jobId: 'job-2', status: 'failed', error: { code: 'timeout', message: 'slow', details: { contactPoint: 'deep_link', appVersion: '2.0', hint: 'link' } } });
  assert.deepEqual(monitor.snapshot()[0].problems.map((item) => item.contactPoint), ['send_label'], 'An ambiguous timeout is logged but is not a problem');
  assert.equal(diagnostics.list().at(-1).code, 'timeout');
  monitor.observe({ harness: 'desk', jobId: 'job-3', status: 'sent' });
  assert.equal(monitor.riskFor('desk'), null, 'A successful send proves the interface works');
  monitor.observe({ harness: 'desk', jobId: 'job-4', status: 'failed', error });
  await new Promise((resolve) => setImmediate(resolve));
  fake.state.compatibility = passing();
  await monitor.check('desk');
  assert.equal(monitor.riskFor('desk'), null, 'So does a full check that saw the send button');
  monitor.observe({ harness: 'plain', status: 'failed', error });
  assert.equal(monitor.snapshot().length, 1, 'Harnesses without checkCompatibility are ignored');
});

test('the job service marks scheduled work at risk and reports outcomes, without canceling anything', async () => {
  const { fake, harnesses, monitor, diagnostics, now, advance } = setup({ compatibility: broken() });
  await monitor.check('desk');
  const service = new JobService({ harnesses, now, persist: () => {}, uuid: (() => { let n = 0; return () => `id-${++n}`; })(), observe: monitor.observe, riskFor: monitor.riskFor });
  const job = await service.create({ harness: 'desk', threadId: 'c1', message: 'Continue', whenISO: new Date(now() + 60_000).toISOString(), timeZone: 'UTC' });
  assert.match(job.risk.message, /changed how its message box is labelled/);
  assert.equal(job.status, 'pending');
  fake.state.submitError = appVersionUnsupported({ app: 'Desk App', appVersion: '2.0', verifiedVersion: '1.0', contactPoint: 'composer_label' });
  advance(120_000);
  await service.run(job.id);
  const failed = service.present(service.get(job.id));
  assert.deepEqual([failed.status, failed.error.code, failed.risk], ['failed', 'app_version_unsupported', null], 'Finished jobs carry no risk');
  assert.ok(monitor.riskFor('desk'));
  assert.deepEqual(diagnostics.list().filter((item) => item.source === 'delivery').map((item) => [item.jobId, item.contactPoint]), [[job.id, 'composer_label']]);
});

test('the diagnostics log is bounded, sanitised and never holds message text', () => {
  let saved = null;
  const log = createDiagnosticsLog({ save: (value) => { saved = value; }, now: () => Date.parse('2026-10-01T00:00:00Z') });
  for (let index = 0; index < MAX_ENTRIES + 20; index += 1) log.record({ source: 'delivery', harness: 'desk', contactPoint: 'composer_label', jobId: `job-${index}`, hint: 'x' });
  assert.equal(saved.entries.length, MAX_ENTRIES);
  assert.equal(saved.entries[0].jobId, 'job-20', 'The oldest entries are dropped');
  const entry = log.record({ source: 'nonsense', harness: 'Bad Harness!', contactPoint: '../x', hint: `Bearer abcdefghijklmnopqrstuv ${'y'.repeat(500)}`, message: 'Continue the secret plan', text: 'Continue' });
  assert.deepEqual([entry.source, entry.harness, entry.contactPoint], ['check', 'unknown', 'unknown']);
  assert.equal(entry.hint.length, 300);
  assert.doesNotMatch(JSON.stringify(entry), /abcdefghijklmnop|secret plan|"text"|"message"/);
  const report = log.report({ appVersion: '2.0.0', platform: 'darwin 25.5.0', states: [{ harness: 'desk', label: 'Desk App', appVersion: '2.0', verifiedVersion: '1.0', lastPassing: null, checkedAt: '2026-10-01T00:00:00.000Z', problems: [{ contactPoint: 'composer_label', source: 'check' }] }] });
  assert.match(report, /^Agent Auto-Continue diagnostics\nVersion: 2\.0\.0 on darwin 25\.5\.0/);
  assert.match(report, /- desk: Desk App 2\.0, verified 1\.0, last passed never, last checked 2026-10-01T00:00:00\.000Z, problems: composer_label \(check\)/);
  const restored = createDiagnosticsLog({ load: () => saved });
  assert.equal(restored.list().length, MAX_ENTRIES);
  assert.deepEqual(createDiagnosticsLog({ load: () => { throw new Error('corrupt'); } }).list(), [], 'An unreadable log starts empty');
});
