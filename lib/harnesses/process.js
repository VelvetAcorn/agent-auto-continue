'use strict';

// Safe child-process helpers for CLI adapters: argument arrays only (never a
// shell), explicit working directories, timeouts, bounded output and a
// sanitized environment.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// Variables that tie a child to the process that launched this app, or that
// would change how Electron/Node children start. User configuration such as
// API keys, CLAUDE_CONFIG_DIR, CODEX_HOME and proxies is preserved.
const STRIPPED_ENV = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_EFFORT', 'NODE_OPTIONS', 'NODE_CHANNEL_FD', 'T3_TOKEN', 'OPENCODE_SERVER_PASSWORD'
]);

// Apps launched from Finder get a minimal PATH, so common install locations are searched too.
function executableDirectories(home = os.homedir(), env = process.env) {
  const fromEnv = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const common = [
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.opencode', 'bin'),
    path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'
  ];
  return [...new Set([...fromEnv, ...common].filter((dir) => path.isAbsolute(dir)))];
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Resolves a bare command name to an absolute executable path, or null.
function findExecutable(name, { home, env = process.env, override } = {}) {
  if (override) return path.isAbsolute(override) && isExecutable(override) ? override : null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
  for (const dir of executableDirectories(home, env)) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function childEnv(env = process.env, { executable, home } = {}) {
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || STRIPPED_ENV.has(key) || key.startsWith('ELECTRON_')) continue;
    result[key] = value;
  }
  // Script-based CLIs need their interpreter, which usually sits beside them.
  const dirs = [...(executable ? [path.dirname(executable)] : []), ...executableDirectories(home, env)];
  result.PATH = [...new Set(dirs)].join(path.delimiter);
  return result;
}

function terminate(child, graceMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill('SIGTERM'); } catch { return; }
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }, graceMs);
  timer.unref?.();
  child.once('exit', () => clearTimeout(timer));
}

// Runs a command to completion and collects bounded output.
function runProcess(file, args, { cwd, env, timeoutMs = 15_000, input, maxOutputBytes = 1_000_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false, error = null;
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (spawnError) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: spawnError });
      return;
    }
    const append = (current, chunk) => (current.length < maxOutputBytes ? (current + chunk).slice(0, maxOutputBytes) : current);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => { /* The child may exit before reading input. */ });
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error });
    };
    child.on('error', (spawnError) => { error = spawnError; if (child.pid === undefined) finish(null, null); });
    child.on('close', finish);
    child.stdin.end(input === undefined ? undefined : input);
  });
}

// Starts a long-running command whose stdout is newline-delimited JSON.
// `onMessage` receives parsed objects; unparseable lines are ignored.
function spawnJsonLines(file, args, { cwd, env, onMessage, maxStderrBytes = 64_000 }) {
  const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stderr = '';
  let spawnError = null;
  child.stderr.setEncoding('utf8').on('data', (chunk) => { if (stderr.length < maxStderrBytes) stderr = (stderr + chunk).slice(0, maxStderrBytes); });
  child.stdin.on('error', () => { /* The child may exit before reading input. */ });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && typeof message === 'object') onMessage(message);
  });
  const exited = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error; if (child.pid === undefined) resolve({ code: null, signal: null, error }); });
    child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  return {
    child, exited,
    get stderr() { return stderr; },
    write(value) { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`); },
    end() { if (child.stdin.writable) child.stdin.end(); },
    terminate: (graceMs) => terminate(child, graceMs),
    interrupt() { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGINT'); } catch { /* Already exited. */ } } }
  };
}

function firstLine(text, max = 240) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, max) || '';
}

module.exports = { STRIPPED_ENV, childEnv, executableDirectories, findExecutable, firstLine, isExecutable, runProcess, spawnJsonLines, terminate };
