'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES, claudeDesktop, codexDesktop, deepLinkFor, defineProfile } = require('../lib/desktop/profiles');
const { isDesktopThread, ownerOfThread } = require('../lib/harnesses/codex-reader');
const { claudePaths } = require('../lib/harnesses/claude-sessions');
const claude = require('../lib/harnesses/claude-desktop');
const codex = require('../lib/harnesses/codex-desktop');

test('each desktop harness has one frozen profile with the verified app version', () => {
  assert.deepEqual(Object.keys(PROFILES), ['claude-desktop', 'codex-desktop']);
  assert.equal(claudeDesktop.verifiedVersion, '2.16120.0');
  assert.equal(codexDesktop.verifiedVersion, '26.915.31945');
  for (const profile of Object.values(PROFILES)) {
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.controls.composer.english), true);
    assert.throws(() => { profile.controls.send.english.push('Submit'); }, TypeError);
  }
});

test('harnesses take their contact points from the profiles', () => {
  assert.equal(claude.BUNDLE_ID, claudeDesktop.bundleId);
  assert.deepEqual(claude.CONTROLS.composer.ids, ['iWKE8shLIt', 'uxkiTeN6WU']);
  assert.equal(codex.BUNDLE_ID, codexDesktop.bundleId);
  assert.deepEqual(codex.TARGET, { composerLabels: ['Do anything', 'Ask for follow-up changes'], sendLabels: ['Send', 'Send message'], stopLabels: ['Stop'] });
  assert.equal(deepLinkFor(claudeDesktop, 'local_7de42224-49eb-4544-a87c-181a7de40229'), 'claude://code/continue?session=local_7de42224-49eb-4544-a87c-181a7de40229');
  assert.equal(deepLinkFor(codexDesktop, 'a/b'), 'codex://threads/a%2Fb', 'IDs are encoded into the link');
});

test('file locations and ownership rules are read from the profiles', () => {
  const paths = claudePaths({ home: '/home/me', env: {} });
  assert.deepEqual(paths, { configDir: '/home/me/.claude', projectsDir: '/home/me/.claude/projects', sessionsDir: '/home/me/.claude/sessions', desktopDir: '/home/me/Library/Application Support/Claude' });
  assert.equal(claudePaths({ home: '/home/me', env: { CLAUDE_CONFIG_DIR: '/cfg' } }).projectsDir, '/cfg/projects');
  assert.equal(claudePaths({ home: '/home/me', env: { CLAUDE_CONFIG_DIR: 'relative' } }).configDir, '/home/me/.claude', 'Only absolute overrides are used');
  assert.equal(ownerOfThread({ originator: 'Codex Desktop', source: 'vscode' }), 'codex-desktop');
  assert.equal(ownerOfThread({ originator: null, source: 'exec' }), 'codex');
  assert.equal(ownerOfThread({ originator: 't3code_anything' }), 't3');
  assert.equal(ownerOfThread({ originator: '' }), 'other');
  assert.equal(ownerOfThread({ originator: 42 }), 'other');
  assert.equal(isDesktopThread({ originator: undefined, source: 'vscode' }), true);
  assert.equal(isDesktopThread({ originator: 'codex_exec', source: 'vscode' }), false, 'An originator always wins over the source');
});

test('a profile with a broken contact point fails when it is loaded', () => {
  const valid = { harness: 'x', appLabel: 'X', bundleId: 'com.example.x', verifiedVersion: '1', appCandidates: ['/Applications/X.app'],
    deepLink: { schemes: ['x'], template: 'x://open/{id}' }, conversationId: /^x$/, content: { by: 'title' },
    controls: { composer: { ids: [], english: ['Prompt'] }, send: { ids: [], english: ['Send'] }, stop: { ids: [], english: [] } } };
  assert.equal(defineProfile({ ...valid }).harness, 'x');
  for (const broken of [
    { ...valid, verifiedVersion: '' },
    { ...valid, deepLink: { schemes: ['x'], template: 'x://open' } },
    { ...valid, deepLink: { schemes: ['y'], template: 'x://open/{id}' } },
    { ...valid, content: { by: 'guess' } },
    { ...valid, controls: { ...valid.controls, send: { ids: [], english: [] } } },
    { ...valid, bundledFiles: { binary: { path: '../escape', required: true } } }
  ]) assert.throws(() => defineProfile(broken), /App profile "x" is invalid/);
});
