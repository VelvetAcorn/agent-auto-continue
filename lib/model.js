'use strict';

const { normaliseKeepAwake } = require('./keep-awake');
const MAX_MESSAGE_LENGTH = 4_000;
const JOB_STATUSES = new Set(['pending', 'dispatching', 'sent', 'failed', 'canceled', 'unconfirmed']);

const LAYOUTS = new Set(['rail', 'window']);
const MAX_AGENT_IDS = 50;

// Agent ids are plain identifiers; unknown ones are dropped when the registry is consulted.
function idList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item === 'string' && /^[a-z0-9-]{1,64}$/.test(item) && !seen.has(item)) seen.add(item);
    if (seen.size >= MAX_AGENT_IDS) break;
  }
  return [...seen];
}

// How the agents appear in the interface: their order and which ones are hidden.
function normaliseAgents(value) {
  const input = value && typeof value === 'object' ? value : {};
  return { order: idList(input.order), hidden: idList(input.hidden) };
}

function normaliseConfig(value = {}) {
  const port = Number(value.httpPort);
  const buffer = Number(value.bufferSeconds);
  return {
    t3Token: typeof value.t3Token === 'string' ? value.t3Token.trim() : '',
    httpPort: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 3773,
    bufferSeconds: Number.isFinite(buffer) && buffer >= 0 && buffer <= 300 ? buffer : 5,
    keepAwake: normaliseKeepAwake(value.keepAwake),
    agents: normaliseAgents(value.agents),
    layout: LAYOUTS.has(value.layout) ? value.layout : 'rail'
  };
}

// Renderer input for the agent arrangement. Only known ids are kept, in the order given;
// agents not mentioned follow in registry order, so a new harness is never lost.
function validateAgentsInput(input, knownIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid agent arrangement.');
  if (!Array.isArray(input.order) || !Array.isArray(input.hidden)) throw new Error('Invalid agent arrangement.');
  const agents = normaliseAgents(input);
  const known = new Set(knownIds);
  return { order: agents.order.filter((id) => known.has(id)), hidden: agents.hidden.filter((id) => known.has(id)) };
}

// The agents in display order: configured order first, then the rest in registry order.
function arrangeAgents(ids, agents) {
  const { order, hidden } = normaliseAgents(agents);
  const known = new Set(ids);
  const ordered = order.filter((id) => known.has(id)).concat(ids.filter((id) => !order.includes(id)));
  return ordered.map((id) => ({ id, hidden: hidden.includes(id) }));
}

function validateLayoutInput(value) {
  if (!LAYOUTS.has(value)) throw new Error('Choose the rail or the window layout.');
  return value;
}

// `requireTime: false` is used when a schedule starts as soon as the agent is
// available, so no send time is requested. `now` is the caller's clock, so the
// job service judges "in the future" by the same clock it schedules with.
function validateScheduleInput(input, { requireTime = true, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Invalid schedule request.');
  const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!requireTime) {
    if (!threadId || threadId.length > 512) throw new Error('Invalid thread ID.');
    if (!message || message.length > MAX_MESSAGE_LENGTH) throw new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
    return { threadId, message, whenISO: null };
  }
  if (typeof input.whenISO !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.whenISO)) throw new Error('Choose a valid date and time with an explicit timezone offset.');
  const [year, month, day] = input.whenISO.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('Choose a valid date and time.');
  const date = new Date(input.whenISO);

  if (!threadId || threadId.length > 512) throw new Error('Invalid thread ID.');
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
  if (Number.isNaN(date.valueOf())) throw new Error('Choose a valid date and time.');
  if (date.valueOf() <= now) throw new Error('The scheduled time must be in the future.');

  return { threadId, message, whenISO: date.toISOString() };
}

function buildTurnStartCommand(job, thread) {
  if (!thread?.modelSelection || !thread.runtimeMode || !thread.interactionMode) {
    throw new Error('T3 Code did not return the thread runtime settings required to send a follow-up.');
  }
  return {
    type: 'thread.turn.start',
    commandId: job.commandId,
    threadId: job.threadId,
    message: { messageId: job.messageId, role: 'user', text: job.message, attachments: [] },
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: new Date().toISOString()
  };
}

function validateSettingsInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
  const httpPort = Number(input.httpPort);
  const bufferSeconds = Number(input.bufferSeconds);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65_535) {
    throw new Error('Port must be a whole number between 1 and 65535.');
  }
  if (!Number.isFinite(bufferSeconds) || bufferSeconds < 0 || bufferSeconds > 300) {
    throw new Error('Safety buffer must be between 0 and 300 seconds.');
  }
  if (input.t3Token !== undefined && typeof input.t3Token !== 'string') {
    throw new Error('Token must be text.');
  }
  return { httpPort, bufferSeconds, t3Token: input.t3Token?.trim() || '' };
}

function isJob(value) {
  return Boolean(value && typeof value === 'object' &&
    typeof value.id === 'string' && typeof value.threadId === 'string' &&
    typeof value.messageId === 'string' && typeof value.commandId === 'string' &&
    typeof value.message === 'string' && typeof value.scheduleAt === 'string' &&
    JOB_STATUSES.has(value.status) && !Number.isNaN(new Date(value.scheduleAt).valueOf()));
}

function readJobs(value) {
  return Array.isArray(value) ? value.filter(isJob) : [];
}

function hasMessageId(value, messageId, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value.messageId === messageId || value.id === messageId) return true;
  return Object.values(value).some((child) => hasMessageId(child, messageId, seen));
}

function findLatestUserTurnAt(value) {
  const messageTimes = (Array.isArray(value?.messages) ? value.messages : [])
    .filter((message) => message?.role === 'user')
    .map((message) => new Date(message.createdAt))
    .filter((date) => !Number.isNaN(date.valueOf()));
  if (messageTimes.length) return new Date(Math.max(...messageTimes.map((date) => date.valueOf())));
  const direct = [value?.latestUserMessageAt, value?.latestUserTurnAt];
  for (const timestamp of direct) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.valueOf())) return date;
  }
  const turn = value?.latestTurn;
  if (turn && (turn.role === 'user' || turn.message?.role === 'user')) {
    for (const timestamp of [turn.createdAt, turn.message?.createdAt, turn.timestamp]) {
      const date = new Date(timestamp);
      if (!Number.isNaN(date.valueOf())) return date;
    }
  }
  return null;
}

module.exports = {
  arrangeAgents, normaliseAgents, validateAgentsInput, validateLayoutInput,
  MAX_MESSAGE_LENGTH,
  buildTurnStartCommand,
  findLatestUserTurnAt,
  hasMessageId,
  isJob,
  normaliseConfig,
  readJobs,
  validateSettingsInput,
  validateScheduleInput
};
