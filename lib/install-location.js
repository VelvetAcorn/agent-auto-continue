'use strict';

// Offers to move a downloaded copy of the app into /Applications on its first launch there.
// A copy left in Downloads or on the disk image works, but macOS runs a freshly downloaded app
// from a randomised read-only location ("App Translocation"), where it cannot update itself and
// is gone once the disk image is ejected. Moving uses Electron's app.moveToApplicationsFolder(),
// which copies the bundle, relaunches it from Applications and quits this copy.
//
// "Not Now" is remembered for the folder the copy runs from, so a copy someone deliberately keeps
// elsewhere is not asked about on every launch. A translocated copy or one running from a disk
// image is always asked, because those locations are temporary and break updates.
//
// The single-instance lock: a second copy normally quits at once and the running one comes to
// the front. The exception is a newer download started while an older copy runs from
// Applications; that one asks to replace the older copy, quits it, and then moves itself.
// Everything that touches the system is injected, so the decisions are unit-tested.

const path = require('node:path');

const DECLINED_LIMIT = 20;
const QUIT_WAIT_MS = 15_000;
const QUIT_POLL_MS = 200;

// /X/Name.app/Contents/MacOS/Name -> /X/Name.app
function bundlePathOf(execPath) {
  const marker = '.app/Contents/MacOS/';
  const index = String(execPath || '').lastIndexOf(marker);
  return index === -1 ? null : execPath.slice(0, index + 4);
}

function locationOf(bundlePath, home = '') {
  const folder = path.dirname(bundlePath || '');
  if (/\/AppTranslocation\//.test(bundlePath || '')) return { kind: 'translocated', temporary: true, label: 'a temporary read-only copy macOS made because it was opened where it was downloaded', why: 'so it cannot update itself' };
  if (folder.startsWith('/Volumes/')) return { kind: 'disk-image', temporary: true, label: 'the disk image', why: 'so it cannot update itself and stops working once the disk image is ejected' };
  if (home && folder === path.join(home, 'Downloads')) return { kind: 'downloads', temporary: false, label: 'your Downloads folder' };
  if (home && folder === path.join(home, 'Desktop')) return { kind: 'desktop', temporary: false, label: 'your Desktop' };
  return { kind: 'other', temporary: false, label: home && folder.startsWith(`${home}/`) ? `~/${folder.slice(home.length + 1)}` : folder };
}

// Numeric comparison of dotted versions; a pre-release sorts before its release.
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre] = String(value || '0').split('-', 2);
    return { parts: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre || '' };
  };
  const left = parse(a), right = parse(b);
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length, 3); index++) {
    const difference = (left.parts[index] || 0) - (right.parts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

// CFBundleShortVersionString from a bundle's XML Info.plist, or null when there is no readable bundle.
function readBundleVersion(fs, bundlePath) {
  try {
    const plist = fs.readFileSync(path.join(bundlePath, 'Contents', 'Info.plist'), 'utf8');
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return match ? match[1].trim() : '0';
  } catch { return null; }
}

function createInstallLocation({
  app, dialog, fs, execPath, home = '', platform = process.platform, appName = 'Agent Auto-Continue',
  load = () => null, save = () => {},
  // PIDs of running copies whose executable is this path. Defaults are wired in main.js.
  findRunning = async () => [], terminate = (pid) => process.kill(pid, 'SIGTERM'), isAlive = () => false,
  // Opens a bundle once this process has exited, so the single-instance lock is free for it.
  openAfterExit = () => {},
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), log = () => {},
  applicationsFolder = '/Applications', quitWaitMs = QUIT_WAIT_MS
}) {
  const bundlePath = bundlePathOf(execPath);

  // Whether this launch could offer a move; checked before the single-instance lock decides anything.
  function applies() {
    try {
      return platform === 'darwin' && app.isPackaged === true && Boolean(bundlePath) && typeof app.moveToApplicationsFolder === 'function' && !app.isInApplicationsFolder();
    } catch { return false; }
  }

  function declinedPaths() {
    try {
      const stored = load();
      return Array.isArray(stored?.declined) ? stored.declined.filter((item) => item && typeof item.path === 'string') : [];
    } catch { return []; }
  }
  function rememberDecline(where) {
    if (where.temporary) return;
    const declined = declinedPaths().filter((item) => item.path !== bundlePath);
    declined.push({ path: bundlePath, version: app.getVersion(), at: new Date(now()).toISOString() });
    try { save({ declined: declined.slice(-DECLINED_LIMIT) }); } catch (error) { log('warn', `Could not remember the move choice: ${error.message}`); }
  }
  const declined = (where) => !where.temporary && declinedPaths().some((item) => item.path === bundlePath);

  async function ask(options) {
    const { response } = await dialog.showMessageBox({ type: 'question', title: appName, defaultId: 0, cancelId: 1, noLink: true, ...options });
    return response === 0;
  }
  async function explain(message, detail) {
    try { await dialog.showMessageBox({ type: 'warning', title: appName, message, detail, buttons: ['OK'] }); } catch { /* Nothing more to say. */ }
  }

  // Quits the copies running from `target` and waits for them to exit.
  async function quitRunning(target) {
    const executable = path.join(target, 'Contents', 'MacOS', path.basename(execPath));
    const pids = (await findRunning(executable)).filter((pid) => Number.isInteger(pid) && pid !== process.pid);
    for (const pid of pids) { try { terminate(pid); } catch { /* Already gone. */ } }
    const deadline = now() + quitWaitMs;
    while (pids.some((pid) => isAlive(pid))) {
      if (now() >= deadline) return false;
      await wait(QUIT_POLL_MS);
    }
    return true;
  }

  // Calls Electron's mover. An older copy that is still running is quit first and the move retried;
  // an older copy that is not running goes to the Trash, which the user agreed to in the dialog.
  async function move(target) {
    let conflict = null;
    const attempt = () => app.moveToApplicationsFolder({ conflictHandler: (type) => { conflict = type; return type === 'exists'; } });
    if (attempt()) return true;
    if (conflict !== 'existsAndRunning') return false;
    if (!(await quitRunning(target))) {
      await explain(`The older ${appName} did not quit`, `Quit ${appName} from its menu-bar icon, then open this copy again.`);
      return false;
    }
    return attempt();
  }

  // Returns 'continue' to start the app normally, or 'quit' when this process should end:
  // it is moving (Electron relaunches the moved copy), handing over to the copy in Applications,
  // or it is a second instance.
  async function ensure({ ownsInstance = true } = {}) {
    const fallback = ownsInstance ? 'continue' : 'quit';
    if (!applies()) return fallback;
    const where = locationOf(bundlePath, home);
    const ours = app.getVersion();
    const target = path.join(applicationsFolder, path.basename(bundlePath));
    const existing = readBundleVersion(fs, target);

    try {
      if (existing !== null && compareVersions(existing, ours) >= 0) {
        // The same or a newer version is already installed. A second instance simply hands over.
        if (!ownsInstance || declined(where)) return fallback;
        const same = compareVersions(existing, ours) === 0;
        const open = await ask({
          message: `${appName} ${existing} is already in Applications`,
          detail: `This ${same ? 'is another copy of the same version' : `copy is an older version (${ours})`}, running from ${where.label}. Open the copy in Applications instead? You can then delete this one.`,
          buttons: ['Open from Applications', 'Not Now']
        });
        if (!open) { rememberDecline(where); return 'continue'; }
        openAfterExit(target);
        return 'quit';
      }
      // A second instance only steps in to replace an older copy running from Applications.
      if (!ownsInstance && existing === null) return 'quit';
      if (ownsInstance && declined(where)) return 'continue';

      const why = where.temporary
        ? `It is running from ${where.label}, ${where.why}.`
        : `It is running from ${where.label}. In Applications it is easy to find and keeps itself up to date.`;
      const replace = existing !== null
        ? ` The older version ${existing} in Applications${ownsInstance ? '' : ' quits and'} moves to the Trash. Your schedules and settings are kept.`
        : '';
      const accepted = await ask({
        message: existing !== null ? `Replace ${appName} ${existing} in Applications?` : 'Move to the Applications folder?',
        detail: `${why}${replace}`,
        buttons: ['Move to Applications', 'Not Now']
      });
      if (!accepted) { rememberDecline(where); return fallback; }
      if (await move(target)) return 'quit';
      return fallback;
    } catch (error) {
      log('warn', `Moving to Applications failed: ${error?.message || error}`);
      if (!/rejected the authorization/i.test(String(error?.message))) {
        await explain(`${appName} could not move itself to Applications`, `${error?.message || 'The move failed.'} You can drag it into the Applications folder in Finder instead.`);
      }
      return fallback;
    }
  }

  // Updates cannot be applied to a copy on a read-only location.
  function readOnly() {
    return applies() && locationOf(bundlePath, home).temporary;
  }

  return { applies, ensure, readOnly, bundlePath };
}

module.exports = { createInstallLocation, bundlePathOf, locationOf, compareVersions, readBundleVersion };
