'use strict';

// Read-only access to Claude Code's local session store. The transcript format
// is internal to Claude Code and changes between releases, so every record is
// parsed defensively and unknown shapes are skipped. Verified with 2.1.286:
//   <config>/projects/<encoded cwd>/<session uuid>.jsonl   one JSON record per line
//   <config>/sessions/<pid>.json                            live-process registry
// where <config> is $CLAUDE_CONFIG_DIR or ~/.claude.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { isoOrNull } = require('./contract');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;

function configDirectory(env = process.env, home) {
  return typeof env.CLAUDE_CONFIG_DIR === 'string' && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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

// A message the user typed, as opposed to tool results, meta records, compact
// summaries or subagent (sidechain) traffic.
function isUserPrompt(record) {
  if (record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary || record.message?.role !== 'user') return false;
  const content = record.message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((block) => isObject(block) && (block.type === 'text' || block.type === 'image'));
}

function isMainAssistant(record) {
  return record.type === 'assistant' && !record.isSidechain && isObject(record.message);
}

async function readSlice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead).toString('utf8');
}

// Lists transcript files, most recently modified first. Subagent transcripts
// live in nested folders and are never returned.
async function listTranscripts(projectsDir, limit = 150) {
  let projects;
  try { projects = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
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

async function findTranscript(projectsDir, id) {
  if (!SESSION_ID.test(id || '')) return null;
  let projects;
  try { projects = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const candidate = path.join(projectsDir, project.name, `${id.toLowerCase()}.jsonl`);
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
    else if (!firstPrompt && isUserPrompt(record)) {
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
    const head = await readSlice(handle, 0, Math.min(entry.size, HEAD_BYTES));
    const tailStart = Math.max(0, entry.size - TAIL_BYTES);
    const tail = tailStart >= HEAD_BYTES ? await readSlice(handle, tailStart, entry.size - tailStart) : '';
    const headRecords = parseRecords(head);
    const tailRecords = parseRecords(tail);
    const records = tailStart >= HEAD_BYTES ? [...headRecords, ...tailRecords] : parseRecords(await readSlice(handle, 0, entry.size));
    const conversational = records.some((record) => isUserPrompt(record) || isMainAssistant(record));
    const cwd = [...records].reverse().find((record) => typeof record.cwd === 'string' && path.isAbsolute(record.cwd))?.cwd || '';
    const stamps = records.map((record) => Date.parse(record.timestamp)).filter(Number.isFinite);
    return { id: entry.id, file: entry.file, cwd, title: titleFrom(records), conversational,
      updatedAt: isoOrNull(stamps.length ? Math.max(...stamps) : entry.mtimeMs) };
  } finally { await handle.close(); }
}

// Streams a whole transcript. `deliveryKey` is the user message uuid this app
// supplied; records after it describe the outcome of that turn.
async function scanTranscript(file, deliveryKey) {
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_SCAN_BYTES) throw Object.assign(new Error('Transcript too large'), { code: 'EFBIG' });
  const result = { cwd: '', permissionMode: '', latestUserActivityAt: null, delivered: false, deliveredAt: null, title: '', after: { assistant: null, finished: false, laterPrompt: false } };
  const titles = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isObject(record)) continue;
    if (typeof record.cwd === 'string' && path.isAbsolute(record.cwd)) result.cwd = record.cwd;
    if (record.type === 'permission-mode' && typeof record.permissionMode === 'string') result.permissionMode = record.permissionMode;
    if (['custom-title', 'ai-title', 'summary'].includes(record.type) || (!titles.length && isUserPrompt(record))) titles.push(record);
    if (deliveryKey && record.uuid === deliveryKey && record.type === 'user') { result.delivered = true; result.deliveredAt = isoOrNull(record.timestamp); continue; }
    if (isUserPrompt(record)) {
      if (typeof record.permissionMode === 'string') result.permissionMode = record.permissionMode;
      const at = isoOrNull(record.timestamp);
      if (at && (!result.latestUserActivityAt || at > result.latestUserActivityAt)) result.latestUserActivityAt = at;
      if (result.delivered) result.after.laterPrompt = true;
      continue;
    }
    if (!result.delivered || result.after.laterPrompt) continue;
    if (isMainAssistant(record)) {
      result.after.assistant = {
        apiError: record.isApiErrorMessage === true || typeof record.error === 'string', error: typeof record.error === 'string' ? record.error : '',
        text: textOf(record.message.content).slice(0, 500), stopReason: record.message.stop_reason || null, at: isoOrNull(record.timestamp)
      };
    } else if (record.type === 'system' && record.subtype === 'turn_duration' && !record.isSidechain) {
      result.after.finished = true;
    }
  }
  result.title = titleFrom(titles);
  return result;
}

// Latest provider usage-limit record across recent transcripts, and whether a
// normal assistant reply happened afterwards.
async function recentLimitSignal(projectsDir, files = 8) {
  const entries = await listTranscripts(projectsDir, files);
  let limit = null, lastSuccessAt = null;
  for (const entry of entries) {
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
          if (record.error === 'rate_limit' || /limit/i.test(text)) { if (!limit || at > limit.at) limit = { at, text: text.slice(0, 500), error: record.error || '' }; }
        } else if (!lastSuccessAt || at > lastSuccessAt) lastSuccessAt = at;
      }
    } catch { /* Unreadable transcripts are skipped. */ } finally { await handle?.close(); }
  }
  return { limit, lastSuccessAt };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Sessions currently open in a running Claude Code process.
async function liveSessions(configDir, isAlive = pidAlive) {
  const result = new Map();
  const dir = path.join(configDir, 'sessions');
  let files;
  try { files = await fs.promises.readdir(dir); } catch { return result; }
  await Promise.all(files.filter((name) => /^\d{1,10}\.json$/.test(name)).map(async (name) => {
    try {
      const value = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
      const pid = Number(value?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || typeof value.sessionId !== 'string' || !isAlive(pid)) return;
      result.set(value.sessionId.toLowerCase(), { pid, status: typeof value.status === 'string' ? value.status : '', kind: typeof value.kind === 'string' ? value.kind : '', name: typeof value.name === 'string' ? value.name : '' });
    } catch { /* Registry entries are best effort. */ }
  }));
  return result;
}

module.exports = { SESSION_ID, configDirectory, findTranscript, isUserPrompt, listTranscripts, liveSessions, parseRecords, pidAlive, recentLimitSignal, scanTranscript, summariseTranscript };
