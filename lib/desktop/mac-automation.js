'use strict';

// Node side of desktop-app automation. Every call runs one short-lived
// `osascript -l JavaScript` process with the self-contained program in
// jxa-program.js; the request travels as a JSON literal inside the script, so
// no shell is involved and user text is never interpreted.
// Adapters depend only on the methods returned here, which lets tests use
// tools/fake-desktop-automation.cjs instead of a real user interface.
const { HarnessError, redact } = require('../harnesses/errors');
const { childEnv, runProcess } = require('../harnesses/process');
const { accessibilityProgram } = require('./jxa-program');

const OSASCRIPT = '/usr/bin/osascript';
const OPEN = '/usr/bin/open';
const DEFAULT_TIMEOUT_MS = 20_000;
const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

// Runs one fixed executable with an argument array (never a shell) in its own
// process group, so a timeout stops anything it started too. Rejects like
// execFile: `killed` on a timeout, otherwise the exit code and stderr.
async function run(file, args, { timeout, input } = {}) {
  const result = await runProcess(file, args, { env: childEnv(process.env), timeoutMs: timeout, input, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.timedOut) throw Object.assign(new Error(`${file} timed out`), { killed: true, signal: 'SIGTERM', stderr: result.stderr });
  if (result.error || result.code !== 0) throw Object.assign(new Error(`${file} failed`), { code: result.error?.code ?? result.code, signal: result.signal, stderr: result.stderr });
  return result.stdout;
}

// `schemes` lists the URL schemes an adapter may open, such as ['claude'].
function createMacAutomation({ runFile = run, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  function unsupported() {
    if (platform !== 'darwin') throw new HarnessError('harness_not_installed', 'Desktop app automation is only available on macOS.');
  }
  async function call(request, { timeout = timeoutMs } = {}) {
    unsupported();
    const source = `(${accessibilityProgram.toString()})(${JSON.stringify(request)})`;
    let stdout;
    try {
      stdout = await runFile(OSASCRIPT, ['-l', 'JavaScript', '-'], { timeout, input: source });
    } catch (error) {
      if (error.killed || error.signal === 'SIGTERM') throw new HarnessError('timeout', 'The desktop app did not respond to Accessibility requests in time.', { op: request.op });
      throw new HarnessError('process_failed', 'macOS automation failed to run.', { op: request.op, hint: redact(String(error.stderr || '').split('\n')[0]).slice(0, 200) });
    }
    try {
      const result = JSON.parse(String(stdout).trim());
      if (!result || typeof result !== 'object') throw new Error('not an object');
      return result;
    } catch {
      throw new HarnessError('unexpected_response_format', 'macOS automation returned an unexpected result.', { op: request.op });
    }
  }
  return {
    accessibilitySettingsUrl: ACCESSIBILITY_SETTINGS_URL,
    // { trusted, screenLocked, onConsole, frontmost: { bundleId, pid }, apps: { [bundleId]: { installedPath, version, running, pid, active } },
    //   handlers: { [scheme]: { path, bundleId } | null } } for each of `schemes`, the app Launch Services would open its links with.
    environment(bundleIds, { schemes = [] } = {}) { return call({ op: 'environment', bundleIds, schemes }); },
    // target: { bundleId, match: { urlSegment } | { title }, composerLabels, sendLabels, stopLabels }
    // Read-only: [{ url, title, language }] for every web content area, for diagnostics.
    contentAreas(bundleId) { return call({ op: 'contentAreas', bundleId }); },
    inspect(target) { return call({ op: 'inspect', ...target }); },
    setComposer(target, text) { return call({ op: 'setComposer', ...target, text }); },
    submit(target, text) { return call({ op: 'submit', ...target, text }); },
    clearComposer(target, text) { return call({ op: 'clearComposer', ...target, text }); },
    activate(pid) { return call({ op: 'activate', pid }); },
    // Opens an app URL through Launch Services without asking it to activate.
    // Apps may still bring themselves to the front while handling the URL.
    async openUrl(url, schemes) {
      unsupported();
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
      if (!scheme || !schemes.includes(scheme)) throw new HarnessError('unexpected', 'Refused to open an unexpected URL.');
      try { await runFile(OPEN, ['-g', url], { timeout: 10_000 }); } catch {
        throw new HarnessError('process_failed', 'macOS could not open the desktop app link.');
      }
    }
  };
}

module.exports = { ACCESSIBILITY_SETTINGS_URL, createMacAutomation, run };
