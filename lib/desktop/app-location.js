'use strict';

// Where a desktop app is installed, and the files inside it a harness reads.
// The app is located by bundle ID through Launch Services (the `environment`
// automation operation asks NSWorkspace), so a copy outside /Applications is
// found too. Only when that is unavailable are the profile's candidate paths
// tried. A required file missing from an app that was found means the app
// changed, which is reported as app_version_unsupported with contact point
// `app_path`, never as "not installed".
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessError, appVersionUnsupported } = require('../harnesses/errors');

// Launch Services answers are reused this long, so frequent reads do not each
// start an osascript process; an app update is picked up after at most this.
const LOOKUP_TTL_MS = 60_000;

function expandHome(candidate, home) {
  return candidate === '~' ? home : candidate.startsWith('~/') ? path.join(home, candidate.slice(2)) : candidate;
}
// Paths in logs and bug reports show the home folder as ~.
function tidy(file, home) {
  return file && home && file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

function createAppLocator({ profile, automation, home = os.homedir(), exists = (file) => fs.existsSync(file), now = () => Date.now(), ttlMs = LOOKUP_TTL_MS }) {
  let cached = null;
  let pending = null;
  async function lookup() {
    let found = null;
    try {
      const env = await automation.environment([profile.bundleId]);
      const app = env?.apps?.[profile.bundleId];
      if (app?.installedPath) found = { appPath: app.installedPath, appVersion: app.version || null, source: 'launch-services' };
    } catch { /* Launch Services is unavailable (for example off macOS); try the usual locations. */ }
    if (!found) {
      const candidate = profile.appCandidates.map((item) => expandHome(item, home)).find((item) => exists(item));
      found = candidate ? { appPath: candidate, appVersion: null, source: 'candidate' } : { appPath: null, appVersion: null, source: 'none' };
    }
    return { ...found, at: now() };
  }
  // { appPath, appVersion, source: 'launch-services' | 'candidate' | 'none' }
  async function locate({ fresh = false } = {}) {
    if (!fresh && cached && now() - cached.at < ttlMs) return cached;
    pending ||= lookup().then((value) => { cached = value; return value; }).finally(() => { pending = null; });
    return pending;
  }
  // { app, file, missing } where `missing` is null, 'app' or 'file'.
  async function bundledFile(key, options) {
    const spec = profile.bundledFiles[key];
    if (!spec) throw new TypeError(`Profile "${profile.harness}" has no bundled file "${key}".`);
    const app = await locate(options);
    if (!app.appPath) return { app, file: null, missing: 'app' };
    const file = path.join(app.appPath, spec.path);
    return exists(file) ? { app, file, missing: null } : { app, file: null, missing: 'file' };
  }
  // Resolves a bundled file's path, or throws a certain failure saying why it is unusable.
  async function requireBundledFile(key, { what = 'file', ...options } = {}) {
    const found = await bundledFile(key, options);
    if (found.missing === 'app') throw new HarnessError('harness_not_installed', `${profile.appLabel} is not installed.`);
    if (found.missing === 'file') {
      throw appVersionUnsupported({ app: profile.appLabel, appVersion: found.app.appVersion, verifiedVersion: profile.verifiedVersion, contactPoint: 'app_path', during: 'read',
        hint: `${profile.appLabel} was found at ${tidy(found.app.appPath, home)}, but its ${what} is not at ${profile.bundledFiles[key].path} inside it.` });
    }
    return found.file;
  }
  return { locate, bundledFile, requireBundledFile, forget() { cached = null; } };
}

module.exports = { LOOKUP_TTL_MS, createAppLocator, expandHome };
