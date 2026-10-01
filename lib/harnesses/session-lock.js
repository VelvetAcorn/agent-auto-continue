'use strict';

// Detects whether this user's macOS login session can show a user interface
// right now. Desktop-app harnesses cannot deliver while the screen is locked or
// while another user owns the console, and keep-awake cannot change that.
// The IORegistry root lists console sessions (IOConsoleUsers); reading it needs
// no permission and no shell.
const { execFile } = require('node:child_process');

const IOREG = '/usr/sbin/ioreg';

function readIoreg({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(IOREG, ['-n', 'Root', '-d1', '-a'], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

// Reads one plist value that directly follows `<key>name</key>` inside `dict`.
function plistValue(dict, name) {
  const match = new RegExp(`<key>${name}</key>\\s*<(true|false|integer|string)\\s*/?>([^<]*)`).exec(dict);
  if (!match) return undefined;
  if (match[1] === 'true') return true;
  if (match[1] === 'false') return false;
  if (match[1] === 'integer') return Number(match[2]);
  return match[2];
}

// Returns { locked, onConsole } for `uid`, or null when the state is unknown.
function parseConsoleSession(xml, uid) {
  const users = /<key>IOConsoleUsers<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(xml || ''));
  if (!users) return null;
  // Console user entries are flat dictionaries.
  for (const [, dict] of users[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
    if (plistValue(dict, 'kCGSSessionUserIDKey') !== uid) continue;
    return { locked: plistValue(dict, 'CGSSessionScreenIsLocked') === true, onConsole: plistValue(dict, 'kCGSSessionOnConsoleKey') === true };
  }
  return { locked: true, onConsole: false };
}

// true when a UI cannot be driven (locked, or this user is not on the console),
// false when it can, and null when the state could not be read.
async function isScreenLocked({ read = readIoreg, uid = process.getuid?.(), platform = process.platform, timeoutMs } = {}) {
  if (platform !== 'darwin' || !Number.isInteger(uid)) return null;
  try {
    const session = parseConsoleSession(await read({ timeoutMs }), uid);
    return session ? session.locked || !session.onConsole : null;
  } catch { return null; }
}

module.exports = { isScreenLocked, parseConsoleSession };
