'use strict';

// Shared, read-only access to Claude Code and Claude Desktop local state, used
// by the Claude Code CLI adapter and the Claude Desktop adapter so each file
// has exactly one reader. Every format here is internal to Anthropic's apps and
// changes between releases: records are parsed defensively and unknown shapes
// are skipped. Verified with Claude Code 2.1.286 and Claude Desktop on 2026-10-01:
//   <config>/projects/<encoded cwd>/<session uuid>.jsonl        transcript, one JSON record per line
//   <config>/sessions/<pid>.json                                 live-process registry
//   <desktop>/claude-code-sessions/<account>/<org>/local_<uuid>.json   Claude Desktop "Code" sessions
//   <desktop>/plan-usage-history.json                            plan usage samples
// where <config> is $CLAUDE_CONFIG_DIR or ~/.claude and <desktop> is
// ~/Library/Application Support/Claude. The locations and registry statuses
// come from the Claude Desktop profile (lib/desktop/profiles/claude-desktop.js).
// All functions accept `{ home, env, isAlive }` so tests can point them at fixtures.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { MAX_AGENT_MESSAGE_CHARS, isoOrNull } = require('./contract');
const { matchUsageLimit, parseResetTime } = require('./usage-limits');
const { redact } = require('./errors');
const { files: FILES, liveRegistry: LIVE_REGISTRY } = require('../desktop/profiles/claude-desktop');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESKTOP_SESSION_FILE = FILES.codeSessionFile;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
// Registry status -> 'busy' | 'waiting' | 'idle'.
const LIVE_STATES = new Map(Object.entries(LIVE_REGISTRY.statuses).flatMap(([state, statuses]) => statuses.map((status) => [status, state])));
// When several processes hold one session, the entry that refuses most firmly wins.
const LIVE_SEVERITY = { unrecognised: 5, busy: 3, starting: 3, waiting: 2, idle: 1 };
// Claude Desktop's processes name it as their entrypoint in the live registry and
// on every user and assistant record they write to a transcript.
const DESKTOP_ENTRYPOINT = LIVE_REGISTRY.entrypoint;
const writtenByDesktop = (record) => (record.type === 'user' || record.type === 'assistant') && record.entrypoint === DESKTOP_ENTRYPOINT;
// A file being rewritten can be read half-written; it is read once more after this.
const TORN_RETRY_MS = 50;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');

function claudePaths({ home = os.homedir(), env = process.env } = {}) {
  const override = env[FILES.claudeConfigEnv];
  const configDir = typeof override === 'string' && path.isAbsolute(override) ? override : path.join(home, FILES.claudeConfigDir);
  return {
    configDir, projectsDir: path.join(configDir, FILES.transcriptsDir), sessionsDir: path.join(configDir, FILES.liveRegistryDir),
    desktopDir: path.join(home, ...FILES.desktopDir)
  };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}
// Like readJson(), but a file that exists and does not parse is read once more,
// because its writer may have been caught mid-write. Resolves { value, parsed }.
async function readJsonSettled(file) {
  for (let attempt = 0; ; attempt++) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { return { value: null, parsed: false, missing: true }; }
    try { return { value: JSON.parse(text), parsed: true }; } catch {
      if (attempt) return { value: null, parsed: false };
      await new Promise((resolve) => setTimeout(resolve, TORN_RETRY_MS));
    }
  }
}
// A value from an app file, described for a hint without echoing anything long.
function describe(value) {
  if (value === undefined) return 'missing';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  return value === null ? 'null' : typeof value;
}
const finiteOr = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

// Epoch milliseconds may be stored as numbers or numeric strings.
function epochIso(value) {
  if (typeof value === 'string' && /^\d{10,16}$/.test(value)) return isoOrNull(Number(value));
  return isoOrNull(value);
}

// ---------------------------------------------------------------- Claude Desktop

// Session files sit at <store>/<account>/<org>/; files found at other depths, up
// to this many folders down, mean the layout changed.
const STORE_DEPTH = 2;
const STORE_SEARCH_DEPTH = 4;

// Claude Desktop's Code session store, read defensively, as
// { found, files, sessions, unrecognised, drift }. `found` says whether the
// store folder exists; without it there are simply no Code sessions. `drift` is
// a hint when the session files no longer look like what this reader knows: the
// files moved to another folder depth, or none of them (or a clear majority)
// has the fields the harness needs. A session that was created moments ago and
// has no Claude Code session yet is skipped without counting against the store.
// Calibrated on 2026-10-01 against 16 real session files of Claude Desktop
// 2.16120.0: every one had sessionId, a UUID cliSessionId and cwd.
async function readDesktopCodeSessionStore(options = {}) {
  const root = path.join(claudePaths(options).desktopDir, FILES.codeSessionsDir);
  const result = { found: false, files: 0, sessions: [], unrecognised: 0, drift: '' };
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return depth === 0 ? null : []; }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < STORE_SEARCH_DEPTH) await walk(path.join(dir, entry.name), depth + 1);
      else if (entry.isFile() && DESKTOP_SESSION_FILE.test(entry.name)) found.push({ file: path.join(dir, entry.name), depth });
    }
    return entries;
  }
  if (!(await walk(root, 0))) return result;
  result.found = true;
  const placed = found.filter((item) => item.depth === STORE_DEPTH);
  if (!placed.length && found.length) {
    result.drift = `${found.length} session files were found at an unexpected folder depth in the session store, and none at <account>/<org>/.`;
    return result;
  }
  result.files = placed.length;
  let pending = 0;
  const missing = new Map();
  for (const { file } of placed) {
    const { value, missing: gone } = await readJsonSettled(file);
    if (gone) { result.files--; continue; }
    const problems = [];
    if (!isObject(value)) problems.push('not a JSON object');
    else {
      if (typeof value.sessionId !== 'string' || !value.sessionId) problems.push('sessionId');
      if (typeof value.cwd !== 'string') problems.push('cwd');
      if (value.cliSessionId !== undefined && value.cliSessionId !== '' && !SESSION_ID.test(String(value.cliSessionId))) problems.push('cliSessionId');
    }
    if (problems.length) {
      result.unrecognised++;
      for (const problem of problems) missing.set(problem, (missing.get(problem) || 0) + 1);
      continue;
    }
    if (!SESSION_ID.test(value.cliSessionId || '')) { pending++; continue; }
    result.sessions.push({
      sessionId: value.sessionId, cliSessionId: value.cliSessionId.toLowerCase(), cwd: value.cwd, originCwd: typeof value.originCwd === 'string' ? value.originCwd : '',
      title: typeof value.title === 'string' ? value.title : '', archived: value.isArchived === true,
      createdAt: epochIso(value.createdAt), lastActivityAt: epochIso(value.lastActivityAt)
    });
  }
  // More than one file waiting for its Claude Code session, and none ready, means that field changed.
  if ((!result.sessions.length && (result.unrecognised || pending > 1)) || result.unrecognised * 2 > result.files) {
    const [field, count] = [...missing].sort((a, b) => b[1] - a[1])[0] || [];
    result.drift = !field ? `${pending} of ${result.files} session files have no cliSessionId.`
      : `${result.unrecognised} of ${result.files} session files lack the expected fields (most often ${field === 'not a JSON object' ? field : `no usable ${field}`}, in ${count}).`;
  }
  result.sessions.sort((a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0) || a.sessionId.localeCompare(b.sessionId));
  return result;
}

// The sessions Claude Desktop's store lists, without its drift verdict.
async function readDesktopCodeSessions(options = {}) {
  return (await readDesktopCodeSessionStore(options)).sessions;
}

// CLI session IDs that belong to Claude Desktop, archived or not.
async function desktopOwnedCliSessionIds(options = {}) {
  return new Set((await readDesktopCodeSessions(options)).map((session) => session.cliSessionId));
}

// Latest plan-usage sample (percent of the five-hour and seven-day limits).
async function readClaudePlanUsage(options = {}) {
  const value = await readJson(path.join(claudePaths(options).desktopDir, FILES.planUsageFile));
  const samples = Array.isArray(value?.samples) ? value.samples : [];
  let latest = null;
  for (const sample of samples) {
    if (!isObject(sample) || !isObject(sample.u)) continue;
    if (options.org && sample.org !== options.org) continue;
    const at = Number(sample.t);
    const fiveHourPct = Number(sample.u.fh), sevenDayPct = Number(sample.u.sd);
    if (!Number.isFinite(at) || !Number.isFinite(fiveHourPct) || !Number.isFinite(sevenDayPct)) continue;
    if (!latest || at > latest.at) latest = { at, org: typeof sample.org === 'string' ? sample.org : '', fiveHourPct, sevenDayPct };
  }
  return latest ? { sampledAt: new Date(latest.at).toISOString(), org: latest.org, fiveHourPct: latest.fiveHourPct, sevenDayPct: latest.sevenDayPct } : null;
}

// ---------------------------------------------------------------- Live processes

// The live registry: the Claude Code processes that are running, as
// { found, pids, sessions, unidentified }. `found` says whether the registry
// folder exists, and `pids` lists the processes with a readable live entry. `sessions` maps a lowercase CLI session ID to the entry of the process
// holding it: { pid, status, state, drift, waitingFor, entrypoint, kind, ... }.
// `state` is 'busy', 'waiting', 'idle', 'starting' (no status yet, just started)
// or 'unrecognised', in which case `drift` says what changed. `unidentified`
// lists live entries that name no session, which could hold any session.
// Entries of dead processes, and files that are not JSON even on a second read,
// are skipped, as Claude Code itself does.
async function readLiveRegistry(options = {}) {
  const isAlive = options.isAlive || pidAlive;
  const now = (options.now || Date.now)();
  const dir = claudePaths(options).sessionsDir;
  const result = { found: false, pids: [], sessions: new Map(), unidentified: [] };
  let files;
  try { files = await fs.promises.readdir(dir); result.found = true; } catch { return result; }
  await Promise.all(files.map((name) => /^(\d{1,10})\.json$/.exec(name)).filter(Boolean).map(async ([name, digits]) => {
    // Claude Code names each entry after its process ID.
    const pid = Number(digits);
    if (pid <= 0 || !isAlive(pid)) return;
    const { value } = await readJsonSettled(path.join(dir, name));
    if (!isObject(value)) return;
    result.pids.push(pid);
    if (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) {
      result.unidentified.push({ pid, hint: `The live registry entry ${name} of a running process has no session ID (sessionId: ${describe(value.sessionId)}).` });
      return;
    }
    let state = typeof value.status === 'string' ? LIVE_STATES.get(value.status) : undefined;
    let drift = '';
    if (!state) {
      const since = Math.max(finiteOr(value.startedAt, 0), finiteOr(value.updatedAt, 0));
      if (value.status === undefined && since <= now + 60_000 && now - since < LIVE_REGISTRY.startupGraceMs) state = 'starting';
      else {
        state = 'unrecognised';
        drift = value.status === undefined ? `The live registry entry ${name} reports no status.` : `The live registry entry ${name} reports the unknown status ${describe(value.status)}.`;
      }
    }
    const entry = {
      pid, status: typeof value.status === 'string' ? value.status.slice(0, 40) : '', state, drift,
      waitingFor: typeof value.waitingFor === 'string' ? value.waitingFor.slice(0, 200) : '',
      entrypoint: typeof value.entrypoint === 'string' ? value.entrypoint : '', kind: typeof value.kind === 'string' ? value.kind : '',
      hostSessionId: typeof value.hostSessionId === 'string' ? value.hostSessionId : '', name: typeof value.name === 'string' ? value.name : '',
      updatedAt: epochIso(value.statusUpdatedAt ?? value.updatedAt)
    };
    const id = value.sessionId.toLowerCase();
    const rank = (item) => LIVE_SEVERITY[item.state] * 2 + (item.entrypoint === LIVE_REGISTRY.entrypoint ? 0 : 1);
    const held = result.sessions.get(id);
    if (!held || rank(entry) > rank(held) || (rank(entry) === rank(held) && entry.pid < held.pid)) result.sessions.set(id, entry);
  }));
  result.pids.sort((a, b) => a - b);
  result.unidentified.sort((a, b) => a.pid - b.pid);
  return result;
}

// Sessions open in a running Claude process (CLI, SDK or Claude Desktop), keyed by lowercase CLI session ID.
async function readLiveSessions(options = {}) {
  return (await readLiveRegistry(options)).sessions;
}

async function readLiveSession(cliSessionId, options = {}) {
  return (await readLiveSessions(options)).get(lower(cliSessionId)) || null;
}

// ---------------------------------------------------------------- Transcripts

function parseRecords(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); if (isObject(value)) records.push(value); } catch { /* Partial or foreign line. */ }
  }
  return records;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

// A message a person typed, as opposed to tool results, meta or synthetic
// records, compact summaries or subagent (sidechain) traffic.
// Claude Code records Esc/SIGINT as a plain user text record with this text.
const INTERRUPTION = /^\[Request interrupted by user(?: for tool use)?\]$/;
function isInterruption(record) {
  if (record.type !== 'user' || record.isSidechain || record.message?.role !== 'user') return false;
  const content = record.message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 && isObject(content[0]) && content[0].type === 'text' ? content[0].text : '';
  return typeof text === 'string' && INTERRUPTION.test(text.trim());
}

function isHumanPrompt(record) {
  if (isInterruption(record)) return false;
  if (record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary || record.isSynthetic || record.message?.role !== 'user') return false;
  const content = record.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => isObject(block) && (block.type === 'text' || block.type === 'image'));
}

function isMainAssistant(record) {
  return record.type === 'assistant' && !record.isSidechain && isObject(record.message);
}

// ---------------------------------------------------------------- Transcript format

// Whether a transcript's records still look like the format this reader knows,
// so a format change refuses instead of silently hiding user activity and
// delivery evidence. The reader depends on every record having a `type`, and on
// user and assistant records having `message.role`, `message.content` (text or
// a list of blocks) and a parseable `timestamp`. Calibrated against 79 real
// transcripts of Claude Code 2.1.x on 2026-10-01: every record had a type, every
// user and assistant record had those fields, no other record type carried a
// user or assistant message, sessions without any message had at most 11
// records, and no run of records without a message was longer than 26.
const SHAPE_WINDOW = 100;
const QUIET_RECORDS_MAX = 100;
function createShapeTracker() {
  const totals = { records: 0, untyped: 0, messages: 0 };
  const window = [];
  let latest = null;
  const describeType = (value) => (typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : 'missing');
  return {
    add(record) {
      const role = isObject(record.message) ? record.message.role : undefined;
      let kind = typeof record.type === 'string' ? 'other' : 'untyped';
      if (record.type === 'user' || record.type === 'assistant') {
        const content = record.message?.content;
        kind = typeof role === 'string' && (typeof content === 'string' || Array.isArray(content)) && Number.isFinite(Date.parse(record.timestamp)) ? 'message' : 'malformed';
      } else if (role === 'user' || role === 'assistant') kind = 'misfiled';
      totals.records++;
      if (kind === 'untyped') totals.untyped++;
      if (kind === 'message' || kind === 'malformed') totals.messages++;
      if (kind !== 'other' && kind !== 'untyped') latest = { kind, type: describeType(record.type) };
      window.push(kind);
      if (window.length > SHAPE_WINDOW) window.shift();
    },
    // A short technical hint when the records do not look like the known format, or ''.
    drift() {
      if (!totals.records) return '';
      const count = (kind) => window.filter((item) => item === kind).length;
      if (totals.untyped * 2 > totals.records || count('untyped') * 2 > window.length) return `Most transcript records have no type (${totals.untyped} of ${totals.records}).`;
      if (latest?.kind === 'misfiled') return `The newest message is recorded under the unknown record type ${latest.type}.`;
      const messages = count('message') + count('malformed');
      if (messages && count('malformed') * 2 > messages) return `${count('malformed')} of the last ${messages} user and assistant records lack message.role, message.content or a valid timestamp.`;
      if (!totals.messages && totals.records >= QUIET_RECORDS_MAX) return `None of the ${totals.records} transcript records is a user or assistant record.`;
      return '';
    }
  };
}

// The format-change hint for a list of records, or ''.
function transcriptDrift(records) {
  const shape = createShapeTracker();
  for (const record of records) shape.add(record);
  return shape.drift();
}

async function readSlice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

// Top-level transcripts, most recently modified first. Subagent transcripts
// live in nested folders and are never returned.
async function listTranscripts(options = {}, limit = 150) {
  const projectsDir = claudePaths(options).projectsDir;
  let projects;
  try { projects = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch { return []; }
  const entries = [];
  await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
    const dir = path.join(projectsDir, project.name);
    let files;
    try { files = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.jsonl') && SESSION_ID.test(file.name.slice(0, -6))).map(async (file) => {
      try {
        const full = path.join(dir, file.name);
        const stat = await fs.promises.stat(full);
        entries.push({ id: file.name.slice(0, -6).toLowerCase(), file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { /* Removed while listing. */ }
    }));
  }));
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id)).slice(0, limit);
}

async function findTranscriptPath(cliSessionId, options = {}) {
  if (!SESSION_ID.test(cliSessionId || '')) return null;
  const projectsDir = claudePaths(options).projectsDir;
  let projects;
  try { projects = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const candidate = path.join(projectsDir, project.name, `${cliSessionId.toLowerCase()}.jsonl`);
    try { if ((await fs.promises.stat(candidate)).isFile()) return candidate; } catch { /* Not in this project. */ }
  }
  return null;
}

function titleFrom(records) {
  let custom = '', ai = '', summary = '', firstPrompt = '';
  for (const record of records) {
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
    else if (record.type === 'ai-title' && typeof record.aiTitle === 'string') ai = record.aiTitle;
    else if (record.type === 'summary' && typeof record.summary === 'string') summary = record.summary;
    else if (!firstPrompt && isHumanPrompt(record)) {
      const text = textOf(record.message.content).trim();
      if (text && !text.startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').slice(0, 80);
    }
  }
  return (custom || ai || summary || firstPrompt).trim();
}

// Cheap summary from the head and tail of a transcript, for listing.
async function summariseTranscript(entry) {
  const handle = await fs.promises.open(entry.file, 'r');
  try {
    const whole = entry.size <= HEAD_BYTES + TAIL_BYTES;
    const records = whole ? parseRecords(await readSlice(handle, 0, entry.size))
      : [...parseRecords(await readSlice(handle, 0, HEAD_BYTES)), ...parseRecords(await readSlice(handle, entry.size - TAIL_BYTES, TAIL_BYTES))];
    const conversational = records.some((record) => isHumanPrompt(record) || isMainAssistant(record));
    const cwd = [...records].reverse().find((record) => typeof record.cwd === 'string' && path.isAbsolute(record.cwd))?.cwd || '';
    const stamps = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
    return { id: entry.id, file: entry.file, cwd, title: titleFrom(records), conversational, updatedAt: isoOrNull(stamps.length ? Math.max(...stamps) : entry.mtimeMs),
      desktopOwned: records.some(writtenByDesktop), drift: transcriptDrift(records) };
  } finally { await handle.close(); }
}

async function* records(file) {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_SCAN_BYTES) throw Object.assign(new Error('Transcript too large'), { code: 'EFBIG' });
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (isObject(record)) yield record;
  }
}

// Human prompts in order: { uuid, timestamp, text }.
async function readHumanPrompts(file) {
  const prompts = [];
  for await (const record of records(file)) {
    if (isHumanPrompt(record)) prompts.push({ uuid: typeof record.uuid === 'string' ? record.uuid : '', timestamp: isoOrNull(record.timestamp), text: textOf(record.message.content) });
  }
  return prompts;
}

// Streams a whole transcript. Records after the user message whose uuid is
// `promptUuid` describe the outcome of that turn. `drift` is a hint when the
// records do not look like the known format, so nothing read here can be trusted.
// `desktopOwned` says Claude Desktop wrote to the session.
async function scanTranscript(file, promptUuid) {
  const result = { cwd: '', permissionMode: '', latestUserActivityAt: null, delivered: false, deliveredAt: null, title: '', drift: '', desktopOwned: false, after: { assistant: null, lastText: null, finished: false, laterPrompt: false, interrupted: false } };
  const titles = [];
  const shape = createShapeTracker();
  for await (const record of records(file)) {
    shape.add(record);
    if (!result.desktopOwned && writtenByDesktop(record)) result.desktopOwned = true;
    if (typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) result.cwd = record.cwd;
    if (record.type === 'permission-mode' && typeof record.permissionMode === 'string') result.permissionMode = record.permissionMode;
    if (['custom-title', 'ai-title', 'summary'].includes(record.type) || (!titles.length && isHumanPrompt(record))) titles.push(record);
    if (promptUuid && record.uuid === promptUuid && record.type === 'user') { result.delivered = true; result.deliveredAt = isoOrNull(record.timestamp); continue; }
    if (isHumanPrompt(record)) {
      if (typeof record.permissionMode === 'string') result.permissionMode = record.permissionMode;
      const at = isoOrNull(record.timestamp);
      if (at && (!result.latestUserActivityAt || at > result.latestUserActivityAt)) result.latestUserActivityAt = at;
      if (result.delivered) result.after.laterPrompt = true;
      continue;
    }
    if (!result.delivered || result.after.laterPrompt) continue;
    if (isInterruption(record)) { result.after.interrupted = true; result.after.interruptedAt = isoOrNull(record.timestamp); continue; }
    if (isMainAssistant(record)) {
      const apiError = record.isApiErrorMessage === true || typeof record.error === 'string';
      const text = textOf(record.message.content);
      result.after.assistant = {
        apiError, error: typeof record.error === 'string' ? record.error : '',
        text: text.slice(0, 500), stopReason: record.message.stop_reason || null, at: isoOrNull(record.timestamp)
      };
      // Claude Code writes each content block as its own record, so the agent's last message is
      // the newest assistant text of the turn; tool calls and error notices are not messages.
      if (!apiError && text.trim()) result.after.lastText = text.slice(-MAX_AGENT_MESSAGE_CHARS);
    } else if (record.type === 'system' && record.subtype === 'turn_duration' && !record.isSidechain) {
      result.after.finished = true;
    }
  }
  result.title = titleFrom(titles);
  result.drift = shape.drift();
  return result;
}

// Turn outcome for the prompt `promptUuid`, from a scanTranscript() result.
// `running` says whether a live process still owns the session.
function outcomeFromScan(scan, { running = false, now = Date.now() } = {}) {
  if (!scan.delivered) return { state: 'unknown' };
  const last = scan.after.assistant;
  if (last?.apiError) {
    const at = Date.parse(last.at) || now;
    const limit = last.error === 'rate_limit' ? { message: last.text || 'Usage limit reached', resetsAt: parseResetTime(last.text, at) } : matchUsageLimit(last.text, at);
    return {
      state: 'failed', completedAt: last.at,
      error: { code: limit ? 'usage_limited' : 'agent_error', message: redact(limit?.message || last.text || 'Claude reported an error.').slice(0, 240) },
      usageLimit: limit ? { resetsAt: limit.resetsAt, message: redact(limit.message).slice(0, 240) } : null
    };
  }
  const message = scan.after.lastText ? { lastAgentMessage: scan.after.lastText } : {};
  if (scan.after.interrupted && !scan.after.finished) return { state: 'interrupted', completedAt: scan.after.interruptedAt || null, ...message };
  if (scan.after.finished || scan.after.laterPrompt || last?.stopReason === 'end_turn') return { state: 'completed', completedAt: last?.at || null, ...message };
  return { state: running ? 'running' : 'unknown' };
}

async function turnOutcomeAfter(file, promptUuid, options = {}) {
  return outcomeFromScan(await scanTranscript(file, promptUuid), options);
}

// Latest provider usage-limit record across recent transcripts, and whether a
// normal assistant reply happened afterwards.
async function recentLimitSignal(options = {}, files = 8) {
  let limit = null, lastSuccessAt = null;
  for (const entry of await listTranscripts(options, files)) {
    let handle;
    try {
      handle = await fs.promises.open(entry.file, 'r');
      const start = Math.max(0, entry.size - TAIL_BYTES);
      for (const record of parseRecords(await readSlice(handle, start, entry.size - start))) {
        if (!isMainAssistant(record)) continue;
        const at = isoOrNull(record.timestamp);
        if (!at) continue;
        if (record.isApiErrorMessage === true || typeof record.error === 'string') {
          const text = textOf(record.message.content);
          if ((record.error === 'rate_limit' || /limit/i.test(text)) && (!limit || at > limit.at)) limit = { at, text: text.slice(0, 500), error: record.error || '' };
        } else if (!lastSuccessAt || at > lastSuccessAt) lastSuccessAt = at;
      }
    } catch { /* Unreadable transcripts are skipped. */ } finally { await handle?.close(); }
  }
  return { limit, lastSuccessAt };
}

module.exports = {
  SESSION_ID, claudePaths, desktopOwnedCliSessionIds, findTranscriptPath, isHumanPrompt, listTranscripts, outcomeFromScan, parseRecords, pidAlive,
  readClaudePlanUsage, readDesktopCodeSessionStore, readDesktopCodeSessions, readHumanPrompts, readLiveRegistry, readLiveSession, readLiveSessions, recentLimitSignal, scanTranscript,
  summariseTranscript, transcriptDrift, turnOutcomeAfter
};
