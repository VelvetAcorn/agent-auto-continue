'use strict';

// Pure rules for automatic continuations (issue #3). The job service owns
// persistence and timers; this module decides what happens next.
//
// A job with `chain: null` is a plain scheduled message. A job with a chain is
// an automatic continuation: it may start when the agent becomes available and
// may send several turns, one after another, each time the previous turn
// finishes. The job's own delivery fields always describe the current turn;
// finished turns move into `chain.history`.

const TRIGGERS = Object.freeze(['time', 'available', 'time-then-available']);
const CHAIN_STATES = Object.freeze(['active', 'paused', 'stopped', 'finished']);
// Why a pending turn reads availability before sending. Every reason holds
// the turn back only for a known block (see gateDecision); the reason decides
// how the wait is described:
// - availability: the user asked to start when the agent is available.
// - continuation: the previous turn finished normally.
// - limit-reset: the previous turn stopped at a usage limit; `limitResetsAt` holds its reset time.
const WAIT_REASONS = Object.freeze(['availability', 'continuation', 'limit-reset']);
const BACKOFF_MS = Object.freeze([60_000, 120_000, 300_000, 600_000, 900_000]);
// Consecutive turns that finish this quickly suggest the task is already done.
const QUICK_TURN_MS = 60_000;
const QUICK_TURN_STREAK = 3;
const HISTORY_LIMIT = 100;
// Our own message is stamped by the harness at about the time we send it.
const ACTIVITY_TOLERANCE_MS = 2_000;
// Desktop-app harnesses report this while the Mac is locked; checking again is cheap.
const SCREEN_LOCKED = 'screen_locked';
const LOCKED_RETRY_MS = 60_000;
// A local marker for a wait caused by the agent still working in the conversation.
const CONVERSATION_BUSY = 'conversation_busy';
// A local marker for an availability read that threw.
const CHECK_FAILED = 'check_failed';
// Consecutive turns ending at a usage limit before the chain pauses.
const LIMIT_STREAK = 3;
// When a limit is reported without a reset time, the next turn waits this long.
const LIMIT_RETRY_MS = 15 * 60_000;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const utcLabel = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const minutes = (ms) => plural(Math.round(ms / 60_000), 'minute');

// Validates the automation part of a schedule request. `turnLimit` is the total
// number of messages the schedule may send, including the first, so 1 keeps
// today's single-message behaviour. `continuous: true` removes the limit.
function validateAutomation(input = {}) {
  const trigger = input.trigger === undefined || input.trigger === null || input.trigger === '' ? 'time' : input.trigger;
  if (!TRIGGERS.includes(trigger)) throw new Error('Choose when to start: at a time or when the agent is available.');
  if (input.continuous !== undefined && typeof input.continuous !== 'boolean') throw new Error('Invalid continuous mode setting.');
  if (input.continuous === true) return { trigger, limit: null };
  const raw = input.turnLimit === undefined || input.turnLimit === null || input.turnLimit === '' ? 1 : input.turnLimit;
  const limit = typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : raw;
  if (typeof limit !== 'number' || !Number.isInteger(limit)) throw new Error('Turn limit must be a whole number.');
  if (limit < 1) throw new Error('Turn limit must be at least 1. To keep going without a limit, choose Keep continuing until I stop it.');
  if (!Number.isSafeInteger(limit)) throw new Error('Turn limit is too large. To keep going without a limit, choose Keep continuing until I stop it.');
  return { trigger, limit };
}

const needsChain = ({ trigger, limit }) => trigger !== 'time' || limit !== 1;

// What an adapter can support, with a user-facing reason when it cannot.
function automationSupport(adapter) {
  const { capabilities: caps, label } = adapter;
  return {
    whenAvailable: caps.canDetectUsageLimit
      ? { supported: true, reason: caps.canReportResetTime ? `${label} reports usage limits and when they reset.` : `${label} reports usage limits but not when they reset, so the app checks again periodically.` }
      : { supported: false, reason: `${label} does not report usage limits, so the app cannot tell when it becomes available. Choose a time instead.` },
    multipleTurns: caps.canDetectCompletion
      ? { supported: true, reason: `${label} reports when each turn finishes, so the next message waits for it.` }
      : { supported: false, reason: `${label} does not report when the agent finishes a turn, so only one message can be sent safely.` }
  };
}

function assertSupported(adapter, automation) {
  const support = automationSupport(adapter);
  if (automation.trigger !== 'time' && !support.whenAvailable.supported) throw new Error(support.whenAvailable.reason);
  if (automation.limit !== 1 && !support.multipleTurns.supported) throw new Error(support.multipleTurns.reason);
}

function newChain(limit, at) {
  return { limit, state: 'active', reasonCode: null, reason: '', changedAt: at, previousTurns: 0, limitedTurns: 0, quickStreak: 0, limitStreak: 0, history: [] };
}

function isValidChain(chain) {
  return Boolean(chain && typeof chain === 'object' && !Array.isArray(chain) &&
    (chain.limit === null || (Number.isSafeInteger(chain.limit) && chain.limit >= 1)) &&
    CHAIN_STATES.includes(chain.state) && Number.isSafeInteger(chain.previousTurns) && chain.previousTurns >= 0 &&
    Array.isArray(chain.history));
}

const count = (value, max = Number.MAX_SAFE_INTEGER) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0);

function normaliseChain(chain) {
  return {
    limit: chain.limit, state: chain.state, reasonCode: typeof chain.reasonCode === 'string' ? chain.reasonCode : null,
    reason: typeof chain.reason === 'string' ? chain.reason : '', changedAt: chain.changedAt || null,
    previousTurns: chain.previousTurns, limitedTurns: count(chain.limitedTurns, chain.previousTurns),
    quickStreak: count(chain.quickStreak), limitStreak: count(chain.limitStreak),
    history: chain.history.filter((entry) => entry && typeof entry === 'object').slice(-HISTORY_LIMIT)
  };
}

function halt(chain, state, reasonCode, reason, at) {
  return { ...chain, state, reasonCode, reason, changedAt: at };
}

const backoff = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 0), BACKOFF_MS.length - 1)];

// Decides whether a gated pending turn may be sent now, given a fresh
// availability reading. Returns `{ proceed: true }` or when to check again.
// Only a known block holds a turn back, matching the pre-dispatch rule: an
// unknown reading sends, and a turn that then meets a limit reports it.
function gateDecision({ availability, now, bufferMs, attempts }) {
  const resets = Date.parse(availability.resetsAt);
  if (availability.state === 'limited') {
    if (Number.isFinite(resets) && resets > now) return { proceed: false, nextAttemptAt: resets + bufferMs, backoff: false, note: `Waiting for the usage limit to reset at ${utcLabel(resets)}.` };
    // Without a reset time, only a limit the harness itself reported blocks.
    if (Number.isFinite(resets) || availability.source !== 'reported') return { proceed: true };
    const delay = backoff(attempts);
    return { proceed: false, nextAttemptAt: now + delay, backoff: true, note: `The agent reports a usage limit without a reset time. Checking again in ${minutes(delay)}.` };
  }
  if (availability.state === 'unavailable') {
    if (availability.reason === SCREEN_LOCKED) return { proceed: false, nextAttemptAt: now + LOCKED_RETRY_MS, backoff: false, note: 'Waiting for the Mac to be unlocked.' };
    const delay = backoff(attempts);
    const what = availability.reason === CHECK_FAILED ? 'The availability check failed' : 'The agent is unavailable';
    return { proceed: false, nextAttemptAt: now + delay, backoff: true, note: `${what}. Checking again in ${minutes(delay)}.` };
  }
  return { proceed: true };
}

const turnPauses = {
  failed: ['turn_failed', 'The last turn failed'],
  interrupted: ['turn_interrupted', 'The last turn was interrupted'],
  unknown: ['turn_unknown', 'The app could not tell how the last turn ended']
};
const isLimitedTurn = (turn) => Boolean(turn?.usageLimit) || turn?.error?.code === 'usage_limited';
// Turns that count toward the limit: delivered turns that did not end at a usage limit.
const countedTurns = (chain) => chain.previousTurns - (chain.limitedTurns || 0);

// Decides what follows a finished turn of an active chain.
// `force` is used when the user resumes: it skips the safety pauses.
function afterTurn(job, turn, now, { force = false } = {}) {
  const chain = job.chain;
  if (!chain || (chain.state !== 'active' && !force)) return { kind: 'none' };
  if (isLimitedTurn(turn)) {
    const limitStreak = (chain.limitStreak || 0) + 1;
    if (!force && limitStreak >= LIMIT_STREAK) {
      return { kind: 'pause', code: 'repeated_limits', reason: `The last ${LIMIT_STREAK} turns each stopped at a usage limit. Resume once the limit has reset.` };
    }
    return { kind: 'next', waitReason: 'limit-reset', limitResetsAt: turn.usageLimit?.resetsAt || null, limited: true, limitStreak: force ? 0 : limitStreak, quickStreak: 0 };
  }
  const counted = countedTurns(chain) + 1;
  if (chain.limit !== null && counted >= chain.limit) {
    const ending = turn.state === 'completed' ? '' : ` ${turnPauses[turn.state]?.[1] || turnPauses.unknown[1]}.`;
    return { kind: 'finish', code: 'limit_reached', reason: `Sent ${plural(counted, 'turn')}, the turn limit.${ending}` };
  }
  if (turn.state === 'completed' || force) {
    const took = (Date.parse(turn.completedAt) || now) - Date.parse(job.dispatchedAt);
    const quickStreak = turn.state === 'completed' && Number.isFinite(took) && took < QUICK_TURN_MS ? (chain.quickStreak || 0) + 1 : 0;
    if (!force && quickStreak >= QUICK_TURN_STREAK) {
      return { kind: 'pause', code: 'no_progress', reason: `The last ${QUICK_TURN_STREAK} turns each finished in under a minute, so the task may already be complete. Resume to keep continuing.` };
    }
    return { kind: 'next', waitReason: 'continuation', limitResetsAt: null, limited: false, limitStreak: 0, quickStreak: force ? 0 : quickStreak };
  }
  if (turn.error?.code === 'approval_required') {
    return { kind: 'pause', code: 'awaiting_input', reason: 'The agent stopped the turn because it needed your approval or input. Answer it, then resume.' };
  }
  const [code, text] = turnPauses[turn.state] || turnPauses.unknown;
  const detail = typeof turn.error?.message === 'string' && turn.error.message ? `: ${turn.error.message.slice(0, 300)}` : '';
  return { kind: 'pause', code, reason: `${text}${detail}. No further message was sent. Resume to keep continuing.` };
}

function turnRecord(job, number, turn) {
  return {
    number, messageId: job.messageId, deliveryKey: job.deliveryKey || job.messageId, sentAt: job.dispatchedAt || job.confirmedAt || null,
    state: turn?.state || 'unknown', completedAt: turn?.completedAt || null, counted: !isLimitedTurn(turn),
    error: turn?.error?.message ? { code: turn.error.code || null, message: String(turn.error.message).slice(0, 300) } : null, usageLimit: turn?.usageLimit || null
  };
}

// The archived record of the job's current, delivered turn.
const historyEntry = (job, turn) => turnRecord(job, job.chain.previousTurns + 1, turn);

// The time from which conversation activity counts as the user's own, for the
// turn after `job`'s current one. Our own message is stamped at dispatch.
function activitySinceAfter(job, nowIso) {
  const sent = Date.parse(job.dispatchedAt || job.confirmedAt);
  return Number.isFinite(sent) ? new Date(sent + ACTIVITY_TOLERANCE_MS).toISOString() : nowIso;
}

// Serialisable summary for the renderer, tray, keep-awake and remote control.
function describe(job, delivered) {
  const chain = job.chain;
  const sentTurns = chain.previousTurns + (delivered ? 1 : 0);
  const counted = countedTurns(chain) + (delivered && !isLimitedTurn(job.turn) ? 1 : 0);
  const currentTurn = chain.previousTurns + 1;
  // The position in the limit: turns that ended at a usage limit do not use it up.
  const position = countedTurns(chain) + 1;
  const unlimited = chain.limit === null;
  const current = delivered || job.turn ? [{ ...turnRecord(job, currentTurn, job.turn), state: job.turn?.state || 'delivered', current: true }] : [];
  return {
    trigger: job.trigger || 'time', limit: chain.limit, unlimited, state: chain.state, reasonCode: chain.reasonCode, reason: chain.reason,
    changedAt: chain.changedAt, currentTurn, sentTurns, countedTurns: counted, remainingTurns: unlimited ? null : Math.max(0, chain.limit - counted),
    progressLabel: unlimited ? `Turn ${position} · continuous` : chain.limit === 1 ? 'Single turn' : `Turn ${Math.min(position, chain.limit)} of ${chain.limit}`,
    earlierTurnsOmitted: Math.max(0, chain.previousTurns - chain.history.length),
    turns: [...chain.history, ...current]
  };
}

module.exports = {
  ACTIVITY_TOLERANCE_MS, BACKOFF_MS, CHECK_FAILED, CONVERSATION_BUSY, LIMIT_RETRY_MS, LIMIT_STREAK, LOCKED_RETRY_MS, SCREEN_LOCKED, countedTurns, isLimitedTurn, CHAIN_STATES, HISTORY_LIMIT, QUICK_TURN_MS, QUICK_TURN_STREAK, TRIGGERS, WAIT_REASONS,
  activitySinceAfter, afterTurn, assertSupported, automationSupport, backoff, describe, gateDecision, halt, historyEntry,
  isValidChain, needsChain, newChain, normaliseChain, validateAutomation
};
