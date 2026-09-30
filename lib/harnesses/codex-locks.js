'use strict';

// Who is writing a Codex thread. Codex serialises writers with an exclusive
// lock on $CODEX_HOME/thread-writer-locks/<threadId>.lock, held open by the
// app-server that has the thread loaded (codex-cli 0.159; confirmed: a second
// thread/resume fails with "already has an active writer"). The holder is read
// with lsof and classified by its executable. Shared by the Codex CLI adapter
// and the Codex desktop adapter; inject `run` to test without lsof.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_APP = /\/(ChatGPT|Codex)\.app\//;

function codexHome({ home = os.homedir(), env = process.env } = {}) {
  return typeof env.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
}

function codexPaths(options = {}) {
  const root = codexHome(options);
  return { root, locksDir: path.join(root, 'thread-writer-locks'), daemonPidFile: path.join(root, 'app-server-daemon', 'daemon.pid'), controlSocket: path.join(root, 'app-server-control', 'app-server-control.sock') };
}

// Runs a fixed executable with an argument array and a timeout; never a shell.
function runFile(file, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8', shell: false }, (error, stdout) => {
      resolve({ ok: !error || error.code === 1, stdout: String(stdout || ''), missing: error?.code === 'ENOENT' });
    });
  });
}

// Parses `lsof -F pn` output into pid and file name pairs.
function parseLsof(text) {
  const pairs = [];
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isInteger(pid) && pid > 0) pairs.push({ pid, file: line.slice(1) });
  }
  return pairs;
}

async function readDaemonPid(options = {}) {
  try {
    const text = (await fs.promises.readFile(codexPaths(options).daemonPidFile, 'utf8')).trim();
    const pid = /^\d+$/.test(text) ? Number(text) : Number(JSON.parse(text)?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

async function classify(pid, { selfPids = [], daemonPid, run = runFile } = {}) {
  if (selfPids.includes(pid)) return 'self';
  if (daemonPid && pid === daemonPid) return 'daemon';
  const { stdout } = await run(PS, ['-o', 'comm=', '-p', String(pid)]);
  return DESKTOP_APP.test(stdout.trim()) ? 'codex-desktop' : 'other';
}

// Map of threadId -> { pid, owner } for every held writer lock.
// Resolves null when the holders cannot be determined (for example, no lsof).
async function readCodexThreadWriters(options = {}) {
  const run = options.run || runFile;
  const { locksDir } = codexPaths(options);
  if (!fs.existsSync(locksDir)) return new Map();
  const result = await run(LSOF, ['-F', 'pn', '+D', locksDir]);
  if (!result.ok) return null;
  const daemonPid = await readDaemonPid(options);
  const owners = new Map();
  const writers = new Map();
  for (const { pid, file } of parseLsof(result.stdout)) {
    const name = path.basename(file);
    if (path.dirname(file) !== locksDir || !name.endsWith('.lock') || !THREAD_ID.test(name.slice(0, -5))) continue;
    if (!owners.has(pid)) owners.set(pid, await classify(pid, { ...options, run, daemonPid }));
    writers.set(name.slice(0, -5).toLowerCase(), { pid, owner: owners.get(pid) });
  }
  return writers;
}

// { pid, owner: 'self' | 'daemon' | 'codex-desktop' | 'other' } for one thread,
// null when no process holds its lock, or undefined when that cannot be determined.
async function codexThreadWriter(threadId, options = {}) {
  if (!THREAD_ID.test(threadId || '')) return null;
  const run = options.run || runFile;
  const file = path.join(codexPaths(options).locksDir, `${threadId.toLowerCase()}.lock`);
  if (!fs.existsSync(file)) return null;
  const result = await run(LSOF, ['-F', 'pn', '--', file]);
  if (!result.ok) return undefined;
  const holder = parseLsof(result.stdout).find((pair) => pair.file === file);
  if (!holder) return null;
  return { pid: holder.pid, owner: await classify(holder.pid, { ...options, run, daemonPid: await readDaemonPid(options) }) };
}

module.exports = { codexHome, codexPaths, codexThreadWriter, parseLsof, readCodexThreadWriters, readDaemonPid, runFile };
