'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInstallLocation, bundlePathOf, locationOf, compareVersions, readBundleVersion } = require('../lib/install-location');

const HOME = '/Users/tester';
const NAME = 'Agent Auto-Continue';
const DOWNLOADS = `${HOME}/Downloads/${NAME}.app`;
const TRANSLOCATED = `/private/var/folders/ab/cd/T/AppTranslocation/5E3B-11AA/d/${NAME}.app`;
const INSTALLED = `/Applications/${NAME}.app`;
const exe = (bundle) => `${bundle}/Contents/MacOS/${NAME}`;
const plist = (version) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>${NAME}</string><key>CFBundleShortVersionString</key>\n\t<string>${version}</string></dict></plist>`;

// A launch of the packaged app: `answers` are the dialog buttons the user presses, in order.
function setup({ bundle = DOWNLOADS, version = '2.2.0', installed = null, installedRunning = false, answers = [], packaged = true, inApplications = false, platform = 'darwin', stored = null, moveResults, quits = true } = {}) {
  const dialogs = [], moves = [], opened = [], terminated = [];
  let saved = stored;
  let running = installedRunning;
  const files = new Map(installed ? [[`${INSTALLED}/Contents/Info.plist`, plist(installed)]] : []);
  const app = {
    isPackaged: packaged, getVersion: () => version, isInApplicationsFolder: () => inApplications, focus() {},
    moveToApplicationsFolder(options) {
      const outcome = moveResults ? moveResults.shift() : (installed ? (running ? 'existsAndRunning' : 'exists') : null);
      moves.push(outcome);
      if (outcome instanceof Error) throw outcome;
      if (outcome === 'exists' || outcome === 'existsAndRunning') return options.conflictHandler(outcome) === true && outcome === 'exists';
      return true;
    }
  };
  const dialog = { showMessageBox: async (options) => { dialogs.push(options); return { response: answers.length ? answers.shift() : 1 }; } };
  const fs = { readFileSync: (file) => { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); } };
  let clock = 0;
  const location = createInstallLocation({
    app, dialog, fs, execPath: exe(bundle), home: HOME, platform, appName: NAME,
    load: () => saved, save: (value) => { saved = value; },
    findRunning: async (executable) => (running && executable === exe(INSTALLED) ? [4242] : []),
    terminate: (pid) => { terminated.push(pid); if (quits) running = false; },
    isAlive: () => running, openAfterExit: (target) => opened.push(target),
    wait: async (ms) => { clock += ms; }, now: () => clock, quitWaitMs: 1000
  });
  return { location, dialogs, moves, opened, terminated, get saved() { return saved; } };
}

test('paths and versions are understood', () => {
  assert.equal(bundlePathOf(exe(DOWNLOADS)), DOWNLOADS);
  assert.equal(bundlePathOf('/usr/local/bin/node'), null);
  assert.deepEqual([locationOf(TRANSLOCATED, HOME).kind, locationOf(TRANSLOCATED, HOME).temporary], ['translocated', true]);
  assert.deepEqual([locationOf(`/Volumes/${NAME}/${NAME}.app`, HOME).kind, locationOf(`/Volumes/${NAME}/${NAME}.app`, HOME).temporary], ['disk-image', true]);
  assert.equal(locationOf(DOWNLOADS, HOME).label, 'your Downloads folder');
  assert.equal(locationOf(`${HOME}/Tools/${NAME}.app`, HOME).label, '~/Tools');
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
  assert.equal(compareVersions('2.2.0-beta.1', '2.2.0'), -1);
  assert.equal(compareVersions('1.9.0', '2.0.0'), -1);
  const fs = { readFileSync: () => plist('2.1.0') };
  assert.equal(readBundleVersion(fs, INSTALLED), '2.1.0');
  assert.equal(readBundleVersion({ readFileSync: () => { throw new Error('missing'); } }, INSTALLED), null);
});

test('development, other platforms and copies already in Applications are never asked', async () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }, { inApplications: true }]) {
    const { location, dialogs } = setup(options);
    assert.equal(location.applies(), false);
    assert.equal(location.readOnly(), false);
    assert.equal(await location.ensure({ ownsInstance: true }), 'continue');
    assert.equal(await location.ensure({ ownsInstance: false }), 'quit');
    assert.equal(dialogs.length, 0);
  }
});

test('a copy in Downloads is offered the move, and Move to Applications moves it', async () => {
  const run = setup({ answers: [0] });
  assert.equal(run.location.applies(), true);
  assert.equal(run.location.readOnly(), false, 'Downloads is writable, so it can still update');
  assert.equal(await run.location.ensure(), 'quit', 'Electron relaunches the moved copy');
  assert.equal(run.dialogs.length, 1);
  assert.equal(run.dialogs[0].message, 'Move to the Applications folder?');
  assert.deepEqual(run.dialogs[0].buttons, ['Move to Applications', 'Not Now']);
  assert.equal(run.dialogs[0].defaultId, 0);
  assert.equal(run.dialogs[0].cancelId, 1);
  assert.match(run.dialogs[0].detail, /your Downloads folder/);
  assert.deepEqual(run.moves, [null]);
});

test('Not Now is remembered for that folder only, so the same copy is not asked again', async () => {
  const first = setup({ answers: [1] });
  assert.equal(await first.location.ensure(), 'continue');
  assert.equal(first.saved.declined[0].path, DOWNLOADS);
  assert.equal(first.saved.declined[0].version, '2.2.0');
  const again = setup({ stored: first.saved });
  assert.equal(await again.location.ensure(), 'continue');
  assert.equal(again.dialogs.length, 0, 'no nagging on the next launch');
  const elsewhere = setup({ bundle: `${HOME}/Desktop/${NAME}.app`, stored: first.saved, answers: [1] });
  await elsewhere.location.ensure();
  assert.equal(elsewhere.dialogs.length, 1, 'a copy in another folder is asked');
  // An unreadable choice file only means asking again.
  const broken = createInstallLocation({ ...{ app: { isPackaged: true, getVersion: () => '2.2.0', isInApplicationsFolder: () => false, moveToApplicationsFolder: () => true }, dialog: { showMessageBox: async () => ({ response: 1 }) }, fs: { readFileSync: () => { throw new Error('x'); } } }, execPath: exe(DOWNLOADS), home: HOME, platform: 'darwin', load: () => { throw new Error('corrupt'); }, save: () => { throw new Error('disk full'); } });
  assert.equal(await broken.ensure(), 'continue');
});

test('a translocated copy is always asked, even after Not Now, and cannot update itself', async () => {
  const first = setup({ bundle: TRANSLOCATED, answers: [1] });
  assert.equal(first.location.readOnly(), true);
  assert.equal(await first.location.ensure(), 'continue');
  assert.equal(first.saved, null, 'Not Now is not remembered for a temporary location');
  assert.equal(first.dialogs[0].detail, 'It is running from a temporary read-only copy macOS made because it was opened where it was downloaded, so it cannot update itself.');
  const declinedBefore = setup({ bundle: TRANSLOCATED, stored: { declined: [{ path: TRANSLOCATED }] }, answers: [1] });
  await declinedBefore.location.ensure();
  assert.equal(declinedBefore.dialogs.length, 1);
});

test('a copy on the disk image is told it stops working once the image is ejected', async () => {
  const run = setup({ bundle: `/Volumes/${NAME}/${NAME}.app`, answers: [1] });
  assert.equal(run.location.readOnly(), true);
  await run.location.ensure();
  assert.equal(run.dialogs[0].detail, 'It is running from the disk image, so it cannot update itself and stops working once the disk image is ejected.');
});

test('an older copy in Applications that is not running is replaced after saying so', async () => {
  const run = setup({ installed: '2.1.0', answers: [0] });
  assert.equal(await run.location.ensure(), 'quit');
  assert.equal(run.dialogs[0].message, `Replace ${NAME} 2.1.0 in Applications?`);
  assert.match(run.dialogs[0].detail, /moves to the Trash\. Your schedules and settings are kept\./);
  assert.deepEqual(run.moves, ['exists'], 'the conflict handler lets Electron trash the old copy');
});

test('a newer download replaces an older copy still running from Applications by quitting it first', async () => {
  // The older copy holds the single-instance lock, so this launch is the second instance.
  const run = setup({ installed: '2.1.0', installedRunning: true, answers: [0] });
  assert.equal(run.location.applies(), true);
  assert.equal(await run.location.ensure({ ownsInstance: false }), 'quit');
  assert.match(run.dialogs[0].detail, /quits and moves to the Trash/);
  assert.deepEqual(run.terminated, [4242]);
  assert.deepEqual(run.moves, ['existsAndRunning', 'exists']);
});

test('if the running older copy will not quit, the user is told and nothing is moved', async () => {
  const run = setup({ installed: '2.1.0', installedRunning: true, answers: [0], quits: false });
  assert.equal(await run.location.ensure({ ownsInstance: false }), 'quit');
  assert.deepEqual(run.moves, ['existsAndRunning']);
  assert.equal(run.dialogs.length, 2);
  assert.match(run.dialogs[1].message, /did not quit/);
});

test('a second instance otherwise hands over to the running copy without asking', async () => {
  for (const options of [{}, { installed: '2.2.0', installedRunning: true }, { installed: '3.0.0', installedRunning: true }]) {
    const run = setup(options);
    assert.equal(await run.location.ensure({ ownsInstance: false }), 'quit');
    assert.equal(run.dialogs.length, 0);
    assert.deepEqual(run.moves, []);
  }
});

test('when the same or a newer version is installed, the copy offers to open that one instead', async () => {
  const open = setup({ installed: '2.2.0', answers: [0] });
  assert.equal(await open.location.ensure(), 'quit');
  assert.equal(open.dialogs[0].message, `${NAME} 2.2.0 is already in Applications`);
  assert.deepEqual(open.dialogs[0].buttons, ['Open from Applications', 'Not Now']);
  assert.deepEqual(open.opened, [INSTALLED]);
  assert.deepEqual(open.moves, [], 'a newer or equal copy is never replaced');
  const stay = setup({ installed: '3.0.0', answers: [1] });
  assert.equal(await stay.location.ensure(), 'continue');
  assert.match(stay.dialogs[0].detail, /older version \(2\.2\.0\)/);
  assert.equal(stay.saved.declined[0].path, DOWNLOADS);
});

test('a failed move explains itself and the app keeps running where it is', async () => {
  const failed = setup({ answers: [0], moveResults: [new Error('Failed to copy current bundle to the applications folder')] });
  assert.equal(await failed.location.ensure(), 'continue');
  assert.equal(failed.dialogs.length, 2);
  assert.match(failed.dialogs[1].detail, /drag it into the Applications folder/);
  // Cancelling the administrator password prompt is the user's choice, not an error to report.
  const canceled = setup({ answers: [0], moveResults: [new Error('User rejected the authorization request')] });
  assert.equal(await canceled.location.ensure(), 'continue');
  assert.equal(canceled.dialogs.length, 1);
});
