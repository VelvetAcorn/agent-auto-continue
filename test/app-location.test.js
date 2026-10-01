'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppLocator } = require('../lib/desktop/app-location');
const { codexDesktop } = require('../lib/desktop/profiles');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-location-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = (name, withBinary = true) => {
    const bundle = path.join(root, name);
    fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
    if (withBinary) fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'codex'), '');
    return bundle;
  };
  return { root, app };
}

test('the app is found by bundle ID wherever it is installed, and the answer is reused briefly', async (t) => {
  const { root, app } = fixture(t);
  const fake = createFakeDesktopAutomation({ bundleId: codexDesktop.bundleId });
  fake.state.installedPath = app('Tools/ChatGPT.app');
  fake.state.version = '27.0';
  let clock = 0;
  const locator = createAppLocator({ profile: codexDesktop, automation: fake.automation, home: root, now: () => clock });
  assert.equal(await locator.requireBundledFile('codex'), path.join(root, 'Tools/ChatGPT.app/Contents/Resources/codex'));
  assert.deepEqual((({ appPath, appVersion, source }) => ({ appPath, appVersion, source }))(await locator.locate()), { appPath: fake.state.installedPath, appVersion: '27.0', source: 'launch-services' });
  await locator.locate();
  assert.equal(fake.state.calls.filter((call) => call[0] === 'environment').length, 1, 'One Launch Services lookup per minute');
  clock += 61_000;
  await locator.locate();
  assert.equal(fake.state.calls.filter((call) => call[0] === 'environment').length, 2);
});

test('without Launch Services the profile candidates are used, with ~ meaning the home folder', async (t) => {
  const { root, app } = fixture(t);
  app('Applications/ChatGPT.app');
  const automation = { environment: async () => { throw new Error('osascript unavailable'); } };
  // Only the home-folder candidate, so an app installed on this machine cannot interfere.
  const locator = createAppLocator({ profile: { ...codexDesktop, appCandidates: ['/nonexistent/ChatGPT.app', '~/Applications/ChatGPT.app'] }, automation, home: root });
  assert.equal(await locator.requireBundledFile('codex'), path.join(root, 'Applications/ChatGPT.app/Contents/Resources/codex'));
  assert.equal((await locator.locate()).source, 'candidate');
});

test('a found app without its bundled binary is an app change, not a missing app', async (t) => {
  const { root, app } = fixture(t);
  const fake = createFakeDesktopAutomation({ bundleId: codexDesktop.bundleId });
  fake.state.installedPath = app('Applications/ChatGPT.app', false);
  fake.state.version = '27.0';
  const locator = createAppLocator({ profile: codexDesktop, automation: fake.automation, home: root });
  await assert.rejects(locator.requireBundledFile('codex', { what: 'bundled codex binary' }), (error) => {
    assert.equal(error.code, 'app_version_unsupported');
    assert.deepEqual([error.details.contactPoint, error.details.appVersion, error.details.verifiedVersion], ['app_path', '27.0', '26.915.31945']);
    assert.match(error.details.hint, /found at ~\/Applications\/ChatGPT\.app, but its bundled codex binary is not at Contents\/Resources\/codex/);
    assert.doesNotMatch(error.details.hint, new RegExp(root), 'The home folder is not spelled out');
    return true;
  });
  fake.state.installed = false;
  const missing = createAppLocator({ profile: { ...codexDesktop, appCandidates: [path.join(root, 'Nowhere.app')] }, automation: fake.automation, home: root });
  await assert.rejects(missing.requireBundledFile('codex'), (error) => error.code === 'harness_not_installed');
});
