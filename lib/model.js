'use strict';

const MAX_MESSAGE_LENGTH = 4_000;
const JOB_STATUSES = new Set(['pending', 'dispatching', 'sent', 'failed', 'canceled', 'unconfirmed']);

function normaliseConfig(value = {}) {
  const port = Number(value.httpPort);
  const buffer = Number(value.bufferSeconds);
  return {
    t3Token: typeof value.t3Token === 'string' ? value.t3Token.trim() : '',
    httpPort: Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 3773,
    bufferSeconds: Number.isFinite(buffer) && buffer >= 0 && buffer <= 300 ? buffer : 5
  };
}

function validateScheduleInput(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid schedule request.');
  const threadId = typeof input.threadId === 'string' ? input.threadId.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (typeof input.whenISO !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.whenISO)) throw new Error('Choose a valid date and time with an explicit timezone offset.');
  const [year, month, day] = input.whenISO.slice(0, 10).split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('Choose a valid date and time.');
  const date = new Date(input.whenISO);

  if (!threadId || threadId.length > 512) throw new Error('Invalid thread ID.');
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
  if (Number.isNaN(date.valueOf())) throw new Error('Choose a valid date and time.');
  if (date.valueOf() <= Date.now()) throw new Error('The scheduled time must be in the future.');

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
