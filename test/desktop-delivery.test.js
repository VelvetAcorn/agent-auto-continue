'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverThroughUi, normaliseText } = require('../lib/desktop/ui-delivery');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const BUNDLE = 'com.example.agent';

// Builds a delivery against the fake app. The conversation "conv-1" is reached
// through its deep link; evidence appears once the fake app receives the send.
function setup({ view, confirmAfterSend = true, busy = () => null, locked = false } = {}) {
  let clock = 0;
  let evidence = null;
  const fake = createFakeDesktopAutomation({
    bundleId: BUNDLE,
    view: { urlSegment: 'other', ...view },
    navigate: (url) => (url.endsWith('conv-1') ? { urlSegment: 'conv-1' } : null),
    onSend: (text) => { if (confirmAfterSend) evidence = { uuid: 'prompt-1', text }; }
  });
  const run = (overrides = {}) => deliverThroughUi({
    automation: fake.automation, bundleId: BUNDLE, appLabel: 'Agent App', noun: 'session', text: 'Continue',
    target: (language) => ({ bundleId: BUNDLE, match: { urlSegment: 'conv-1' }, composerLabels: language === 'de-DE' ? ['Eingabe', 'Prompt'] : ['Prompt'], sendLabels: ['Send'] }),
    link: { url: 'agent://open/conv-1', schemes: ['agent'] },
    isBusy: async () => busy(), confirm: async () => evidence, isLocked: async () => locked,
    now: () => clock, sleep: async (ms) => { clock += ms; }, timings: { navigateMs: 2000, confirmMs: 3000, pollMs: 500 },
    ...overrides
  });
  return { fake, run };
}
const calls = (fake, name) => fake.state.calls.filter((call) => call[0] === name);
async function rejects(promise, code, uncertain) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.deliveryUncertain, uncertain);
    return true;
  });
}

test('delivers through the deep link, confirms from evidence and restores the previous front app', async () => {
  const { fake, run } = setup();
  const evidence = await run();
  assert.deepEqual(evidence, { uuid: 'prompt-1', text: 'Continue' });
  assert.deepEqual(fake.state.opened, ['agent://open/conv-1']);
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].view.urlSegment, 'conv-1', 'The send happened in the target conversation');
  assert.deepEqual(calls(fake, 'activate').map((call) => call[1]), [777], 'The editor the user was in is brought back');
  assert.deepEqual(fake.state.frontmost, { bundleId: 'com.example.editor', pid: 777 });
});

test('does not open the deep link when the conversation is already shown', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' } });
  await run();
  assert.deepEqual(fake.state.opened, []);
  assert.equal(calls(fake, 'activate').length, 0, 'Focus never moved, so nothing is restored');
});

test('missing permission, locked screen, stopped app and missing app are certain failures before any UI work', async () => {
  for (const [change, code] of [[{ trusted: false }, 'permission_required'], [{ screenLocked: true }, 'screen_locked'], [{ onConsole: false }, 'screen_locked'], [{ running: false }, 'connection_refused'], [{ installed: false }, 'harness_not_installed']]) {
    const { fake, run } = setup();
    Object.assign(fake.state, change);
    await rejects(run(), code, false);
    assert.equal(calls(fake, 'setComposer').length, 0);
    assert.equal(calls(fake, 'openUrl').length, 0);
  }
  const { fake, run } = setup({ locked: true });
  await rejects(run(), 'screen_locked', false);
  assert.equal(calls(fake, 'inspect').length, 0, 'The shared lock helper is consulted too');
});

test('permission errors carry the System Settings link', async () => {
  const { fake, run } = setup();
  fake.state.trusted = false;
  await assert.rejects(run(), (error) => error.details.permission === 'accessibility' && error.details.settingsUrl.startsWith('x-apple.systempreferences:'));
});

test('a conversation that never appears is a certain timeout and nothing is typed', async () => {
  const { fake, run } = setup();
  fake.state.navigationDelay = 100;
  await rejects(run(), 'timeout', false);
  assert.equal(calls(fake, 'setComposer').length, 0);
});

test('a user draft is never overwritten', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1', composer: 'half-written thought' } });
  await rejects(run(), 'conversation_busy', false);
  assert.equal(fake.state.view.composer, 'half-written thought');
  assert.equal(calls(fake, 'clearComposer').length, 0);
});

test('a busy agent is never interrupted, whether reported by the app state or a visible Stop button', async () => {
  const busy = setup({ view: { urlSegment: 'conv-1' }, busy: () => true });
  await rejects(busy.run(), 'conversation_busy', false);
  assert.equal(calls(busy.fake, 'setComposer').length, 0);
  const stop = setup({ view: { urlSegment: 'conv-1', stop: true } });
  await rejects(stop.run(), 'conversation_busy', false);
});

test('an agent that starts working after the text is inserted gets the text removed and nothing is sent', async () => {
  let checks = 0;
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' }, busy: () => (++checks > 1 ? true : false) });
  await rejects(run(), 'conversation_busy', false);
  assert.equal(fake.state.sent.length, 0);
  assert.equal(fake.state.view.composer, '', 'Our own text was cleared again');
});

test('text the app did not accept verbatim is reported as not sent and left alone unless it is exactly ours', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' } });
  fake.state.acceptText = (text) => `${text}!`;
  await rejects(run(), 'unexpected', false);
  assert.equal(fake.state.view.composer, 'Continue!', 'Text that is not exactly ours is never cleared');
  assert.equal(fake.state.sent.length, 0);
});

test('a missing composer or send button means an unsupported app version, not a guess', async () => {
  const composer = setup({ view: { urlSegment: 'conv-1', composerLabel: 'Something else' } });
  await rejects(composer.run(), 'timeout', false);
  const send = setup({ view: { urlSegment: 'conv-1', sendLabel: 'Submit' } });
  await rejects(send.run(), 'unexpected', false);
  assert.equal(send.fake.state.view.composer, '', 'The inserted text is removed again');
});

test('localised labels are used once the content language is known', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1', language: 'de-DE', composerLabel: 'Eingabe' } });
  await run();
  assert.equal(fake.state.sent.length, 1);
});

test('a failed press before submission is certain, but any doubt after it is uncertain', async () => {
  const before = setup({ view: { urlSegment: 'conv-1' } });
  before.fake.state.faults.submit = { ok: false, error: 'send_disabled' };
  await rejects(before.run(), 'unexpected', false);
  assert.equal(before.fake.state.view.composer, '', 'Text is removed when send was never pressed');

  const crashed = setup({ view: { urlSegment: 'conv-1' } });
  crashed.fake.state.faults.submit = Object.assign(new Error('osascript timed out'), { code: 'timeout' });
  await rejects(crashed.run(), 'timeout', true);
  assert.equal(calls(crashed.fake, 'clearComposer').length, 0, 'The composer is never touched once a press may have happened');

  const pressed = setup({ view: { urlSegment: 'conv-1' } });
  pressed.fake.state.faults.submit = { ok: false, error: 'press_failed', pressed: true };
  await rejects(pressed.run(), 'unexpected', true);
});

test('a send without evidence in time is reported as uncertain, never as delivered', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' }, confirmAfterSend: false });
  await rejects(run(), 'timeout', true);
  assert.equal(fake.state.sent.length, 1);
});

test('deliveries run one at a time', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' } });
  const order = [];
  const slow = run({ confirm: async () => { order.push('first-confirm'); return { uuid: 'a' }; } });
  const second = run({ text: 'Again', confirm: async () => { order.push('second-confirm'); return { uuid: 'b' }; } });
  await Promise.all([slow, second]);
  assert.deepEqual(order, ['first-confirm', 'second-confirm']);
  assert.deepEqual(fake.state.sent.map((item) => item.text), ['Continue', 'Again']);
});

test('text comparison ignores trailing whitespace and non-breaking spaces only', () => {
  assert.equal(normaliseText('Continue \n'), 'Continue');
  assert.equal(normaliseText('a b'), 'a b');
  assert.notEqual(normaliseText(' Continue'), 'Continue');
});

test('focus is only given back after the harness itself opened a link', async () => {
  const { fake, run } = setup({ view: { urlSegment: 'conv-1' } });
  let evidence = null;
  fake.state.faults.submit = () => { evidence = { uuid: 'prompt-1' }; return { ok: true, pressed: true }; };
  // While the harness waits for evidence, the user switches to the agent app themselves.
  await run({ confirm: async () => { fake.state.frontmost = { bundleId: BUNDLE, pid: 4242 }; return evidence; } });
  assert.deepEqual(fake.state.opened, []);
  assert.equal(calls(fake, 'activate').length, 0, 'The user is not pulled out of the app they chose');
  assert.equal(fake.state.frontmost.bundleId, BUNDLE);
});
