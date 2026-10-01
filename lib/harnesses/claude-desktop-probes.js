'use strict';

// Claude Desktop's own compatibility probes, run by checkCompatibility() through
// checkDesktopCompatibility(). Each reads local files only (and, for the live
// registry, the process table), never touches the app, and reports a problem
// only on evidence that an update changed a format; anything it cannot inspect
// is unchecked. See "Compatibility checks" in docs/harnesses.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessions = require('./claude-sessions');
const { runProcess } = require('./process');

// A Claude Code process younger than this may not have registered yet.
const PROCESS_MIN_AGE_MS = 60_000;
// Transcripts of this many recently active sessions are sampled.
const TRANSCRIPT_SAMPLE = 3;

// Paths in hints show the home folder as ~.
function tidy(file, home) {
  return file && home && file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// "[[dd-]hh:]mm:ss" from ps, in milliseconds.
function elapsedMs(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(value || '').trim());
  if (!match) return 0;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

// Interactive Claude Code processes that have run for at least `minAgeMs`, as
// [{ pid }], from the process table; null when it cannot be read. Each should
// have an entry in the live registry. Headless runs (-p or --print) and this
// app's own children are left out, because they need not register. Only process
// IDs, ages and flags are read; nothing about the processes is kept or logged.
async function runningClaudeProcesses({ minAgeMs = PROCESS_MIN_AGE_MS, run = runProcess } = {}) {
  const table = await run('/bin/ps', ['-axo', 'pid=,ppid=,etime=,comm='], { timeoutMs: 5_000 });
  if (table.error || table.timedOut || table.code !== 0) return null;
  const candidates = [];
  for (const line of table.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || !/^claude(?:\.exe)?$/.test(path.basename(match[4])) || Number(match[2]) === process.pid) continue;
    if (elapsedMs(match[3]) >= minAgeMs) candidates.push(Number(match[1]));
  }
  if (!candidates.length) return [];
  // ps exits 1 when one of the processes ended in between; the rest are still listed.
  const listed = await run('/bin/ps', ['-o', 'pid=,args=', '-p', candidates.join(',')], { timeoutMs: 5_000 });
  if (listed.error || listed.timedOut) return null;
  const interactive = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && !/(?:^|\s)(?:-p|--print)(?:[\s=]|$)/.test(match[2])) interactive.push({ pid: Number(match[1]) });
  }
  return interactive;
}

// `options` are the claude-sessions options ({ home, env, isAlive, now });
// `processes()` resolves runningClaudeProcesses().
function createClaudeDesktopProbes({ options, processes = () => runningClaudeProcesses() }) {
  const home = options.home || os.homedir();

  // The live registry is where Claude Code still writes it, and its live entries
  // name a session, a known status and the app that started them.
  const liveRegistry = {
    contactPoints: ['live_registry'], depth: 'quick',
    async run() {
      const [registry, running] = await Promise.all([sessions.readLiveRegistry(options), Promise.resolve().then(processes).catch(() => null)]);
      const where = tidy(sessions.claudePaths(options).sessionsDir, home);
      const registered = new Set(registry.pids);
      // Running processes that all lack an entry mean the registry moved or was renamed.
      if (running?.length && !running.some((item) => registered.has(item.pid))) {
        return { problems: [{ contactPoint: 'live_registry', hint: `${plural(running.length, 'Claude Code process has', 'Claude Code processes have')} been running for over a minute, but ${registry.found ? `none has an entry in ${where}` : `${where} does not exist`}.` }] };
      }
      if (!registry.found) return { unchecked: [{ contactPoint: 'live_registry', reason: 'not_found' }] };
      const problems = [];
      const more = (count) => (count > 1 ? ` ${plural(count - 1, 'other entry is', 'other entries are')} like it.` : '');
      if (registry.unidentified.length) problems.push(registry.unidentified[0].hint + more(registry.unidentified.length));
      const entries = [...registry.sessions.values()];
      const unknown = entries.filter((entry) => entry.state === 'unrecognised');
      if (unknown.length) problems.push(unknown[0].drift + more(unknown.length));
      // One old process may omit it; most entries omitting it means the field changed.
      const anonymous = entries.filter((entry) => !entry.entrypoint).length;
      if (anonymous * 2 > entries.length) problems.push(`${anonymous} of ${plural(entries.length, 'live registry entry does', 'live registry entries do')} not say which app started them (no entrypoint).`);
      return problems.length ? { problems: problems.map((hint) => ({ contactPoint: 'live_registry', hint })) } : { checked: ['live_registry'] };
    }
  };

  // Claude Desktop's Code session files still parse into sessions. No store
  // folder means the user has no Code sessions, which is not a change.
  const sessionStore = {
    contactPoints: ['session_store'], depth: 'quick',
    async run() {
      const store = await sessions.readDesktopCodeSessionStore(options);
      if (store.drift) return { problems: [{ contactPoint: 'session_store', hint: store.drift }] };
      if (!store.found || !store.files) return { unchecked: [{ contactPoint: 'session_store', reason: store.found ? 'no_sessions' : 'not_found' }] };
      return { checked: ['session_store'] };
    }
  };

  // The transcripts of the most recently active sessions are still in the
  // format the reader knows. Only their head and tail are read.
  const transcript = {
    contactPoints: ['transcript'], depth: 'full',
    async run() {
      const recent = (await sessions.readDesktopCodeSessions(options)).filter((item) => !item.archived);
      const sampled = [];
      for (const item of recent) {
        if (sampled.length >= TRANSCRIPT_SAMPLE) break;
        const file = await sessions.findTranscriptPath(item.cliSessionId, options);
        if (!file) continue;
        const stat = await fs.promises.stat(file).catch(() => null);
        if (stat?.size) sampled.push(await sessions.summariseTranscript({ id: item.cliSessionId, file, size: stat.size, mtimeMs: stat.mtimeMs }));
      }
      if (!sampled.length) return { unchecked: [{ contactPoint: 'transcript', reason: 'no_transcripts' }] };
      const changed = sampled.filter((summary) => summary.drift);
      if (!changed.length) return { checked: ['transcript'] };
      return { problems: [{ contactPoint: 'transcript', hint: `${changed[0].drift} Seen in ${changed.length} of ${plural(sampled.length, 'recent session', 'recent sessions')}.` }] };
    }
  };

  return [sessionStore, liveRegistry, transcript];
}

module.exports = { PROCESS_MIN_AGE_MS, TRANSCRIPT_SAMPLE, createClaudeDesktopProbes, elapsedMs, runningClaudeProcesses };
