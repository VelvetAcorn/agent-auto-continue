'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { readJobs, validateScheduleInput } = require('./model');
const { toErrorInfo } = require('./harnesses/errors');
const { availability: normaliseAvailability, turnOutcome } = require('./harnesses/contract');
const { DEFAULT_HARNESS, createHarnessRegistry } = require('./harnesses/registry');
const { createT3Harness } = require('./harnesses/t3');
const continuation = require('./continuation');

// Version 4 adds automatic continuations. Older app versions refuse it rather
// than sending a paused or availability-gated turn they do not understand.
const STORE_VERSION = 4;
const terminal = new Set(['sent', 'failed', 'canceled', 'unconfirmed']);
const finishedTurn = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const HARNESS_ID = /^[a-z][a-z0-9-]{0,31}$/;
// Turns still unresolved this long after delivery stop being tracked, so an
// unreachable harness cannot keep activeWork() (and keep-awake) busy forever.
const MAX_TURN_TRACKING_MS = 24 * 3_600_000;
const isoOrNull = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

function deliveryStatus(job) {
  if (!terminal.has(job.status)) return job.status;
  if (job.deliveryCertainty === 'unknown') return 'unconfirmed';
  if (job.deliveryCertainty === 'delivered') return 'sent';
  return job.status;
}
function validRecord(job) {
  return (job.harness === undefined || HARNESS_ID.test(job.harness)) &&
    (job.trigger === undefined || continuation.TRIGGERS.includes(job.trigger)) &&
    (job.chain === undefined || job.chain === null || continuation.isValidChain(job.chain));
}
function migrateJobs(value, bufferSeconds = 5) {
  if (!Array.isArray(value) && (!value || ![2, 3, STORE_VERSION].includes(value.version) || !Array.isArray(value.jobs))) {
    throw new Error('The local schedule file uses an unsupported format. Restore a compatible backup or open it with the app version that created it. Existing data has not been changed.');
  }
  const rows = Array.isArray(value) ? value : value.jobs;
  const valid = readJobs(rows).filter(validRecord);
  if (valid.length !== rows.length) throw new Error('The local schedule file contains invalid records. Restore or repair the file before restarting. Existing data has not been changed.');
  return valid.map((job) => ({
    ...job,
    harness: job.harness || DEFAULT_HARNESS,
    deliveryCertainty: ['unknown', 'delivered', 'not-delivered'].includes(job.deliveryCertainty) ? job.deliveryCertainty :
      job.status === 'sent' ? 'delivered' : ['failed', 'unconfirmed', 'dispatching'].includes(job.status) ? 'unknown' : 'not-delivered',
    bufferSeconds: Number.isFinite(job.bufferSeconds) && job.bufferSeconds >= 0 && job.bufferSeconds <= 300 ? job.bufferSeconds : bufferSeconds,
    timeZone: job.timeZone || null,
    baselineUserTurnAt: job.baselineUserTurnAt || null,
    // Legacy jobs without a creation timestamp cannot safely infer historical activity.
    activitySince: job.activitySince || job.createdAt || null,
    acknowledgedAt: job.acknowledgedAt || null,
    trigger: job.trigger || 'time',
    chain: job.chain ? continuation.normaliseChain(job.chain) : null,
    waitReason: continuation.WAIT_REASONS.includes(job.waitReason) ? job.waitReason : null,
    limitResetsAt: isoOrNull(job.limitResetsAt),
    nextAttemptAt: isoOrNull(job.nextAttemptAt),
    availability: job.availability && typeof job.availability === 'object' ? job.availability : null,
    availabilityChecks: Number.isSafeInteger(job.availabilityChecks) && job.availabilityChecks >= 0 ? job.availabilityChecks : 0
  }));
}
function utcOffsetMinutes(iso, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(iso));
  const label = parts.find((part) => part.type === 'timeZoneName').value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2])*60 + Number(match[3])) : 0;
}
function timezone(value) {
  const zone = value || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { throw new Error('Choose a valid timezone.'); }
  return zone;
}
function harnessId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_HARNESS;
  if (typeof value !== 'string' || !HARNESS_ID.test(value)) throw new Error('Choose a valid agent harness.');
  return value;
}
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const hasAutomationFields = (input) => ['trigger', 'turnLimit', 'continuous'].some((key) => input?.[key] !== undefined);
const runningTurn = (turnId, at) => ({ state: 'running', turnId: turnId || null, completedAt: null, error: null, usageLimit: null, updatedAt: at });

// The read-only view of a job that adapters receive. It never exposes persistence.
function turnRef(job) {
  return Object.freeze({
    jobId: job.id, harness: job.harness, conversationId: job.threadId, message: job.message,
    messageId: job.messageId, commandId: job.commandId, deliveryKey: job.deliveryKey || job.messageId,
    createdAt: job.createdAt || null, dispatchAttemptedAt: job.dispatchAttemptedAt || null, turnId: job.turn?.turnId || null
  });
}

class JobService {
  // `observe({ harness, jobId, status, error })` hears every send outcome, and
  // `riskFor(harness)` returns why scheduled work for a harness may not be sent
  // ({ message, appVersion, contactPoints }) or null; both feed the compatibility monitor.
  constructor({ jobs = [], bufferSeconds = 5, api, harnesses, persist = () => {}, onChange = () => {}, notify = () => {}, scheduleTimer, now = () => Date.now(), uuid = randomUUID, observe = () => {}, riskFor = () => null }) {
    this.jobs = migrateJobs(jobs, bufferSeconds);
    // Since the version 2 store, every send persists dispatchAttemptedAt before it starts.
    // Bare arrays come from version 1, which did not, so their interrupted sends stay uncertain.
    this.attemptsRecorded = !Array.isArray(jobs);
    // Callers that only supply a T3 API client keep the original single-harness behaviour.
    this.harnesses = harnesses || createHarnessRegistry([createT3Harness({ api })]);
    Object.assign(this, { bufferSeconds, api, persist, onChange, notify, scheduleTimer, now, uuid, observe, riskFor });
    this.timers = new Map();
    this.running = new Set();
    this.generations = new Map();
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  save() { this.persist({ version: STORE_VERSION, jobs: this.jobs });
    try { this.onChange(); } catch { /* A disconnected renderer must not change delivery state. */ } }
  tell(title, body) { try { this.notify(title, body); } catch { /* The outcome is already committed. */ } }
  get(id) {
    if (typeof id !== 'string' || id.length > 512) throw new Error('Invalid schedule ID.');
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw Object.assign(new Error('Schedule was not found.'), { code: 'not_found' });
    return job;
  }
  adapterFor(job) { return this.harnesses.get(job.harness); }
  knownAdapter(job) { return this.harnesses.has(job.harness) ? this.harnesses.get(job.harness) : null; }
  harnessLabel(job) { return this.knownAdapter(job)?.label || job.harness; }
  noun(job) { return this.knownAdapter(job)?.conversationNoun || 'conversation'; }
  // When a pending turn is next due: its scheduled time plus buffer, or later while waiting for availability.
  dueAt(job) {
    const base = Date.parse(job.scheduleAt) + job.bufferSeconds * 1000;
    const next = Date.parse(job.nextAttemptAt);
    return Number.isFinite(next) ? Math.max(base, next) : base;
  }
  // A pending turn the scheduler may send without user action.
  armed(job) { return job.status === 'pending' && (!job.chain || job.chain.state === 'active'); }
  // Pending turns that read availability before sending.
  gated(job) { return Boolean(job.waitReason) && this.knownAdapter(job)?.capabilities.canDetectUsageLimit === true; }
  // Pending turns that are held back until the agent is available, rather than simply due at a time.
  waiting(job) { return job.status === 'pending' && (Boolean(job.nextAttemptAt) || (this.gated(job) && job.waitReason !== 'continuation')); }
  // Upcoming holds plain schedules not yet sent and every running automatic continuation.
  upcoming(job) { return job.chain ? job.chain.state === 'active' : !terminal.has(job.status); }
  needsAttention(job) { return !job.acknowledgedAt && (['failed', 'unconfirmed'].includes(deliveryStatus(job)) || job.chain?.state === 'paused'); }
  displayStatus(job, status) {
    if (!job.chain || ['failed', 'unconfirmed'].includes(status)) return status;
    if (job.chain.state !== 'active') return job.chain.state;
    if (status === 'pending') return this.waiting(job) ? 'waiting' : 'pending';
    if (status === 'sent' && job.turn?.state === 'running') return 'running';
    return status;
  }
  // The label of a waiting turn, from the latest reason it is held back.
  waitLabel(job) {
    const reason = job.availability?.reason;
    return reason === continuation.SCREEN_LOCKED ? 'Waiting for unlock' : reason === continuation.CONVERSATION_BUSY ? 'Waiting for the agent to finish' : 'Waiting for availability';
  }
  // Why scheduled work for this job's harness may not be sent, from the compatibility monitor.
  risk(job) {
    if (terminal.has(job.status)) return null;
    try { return this.riskFor(job.harness) || null; } catch { return null; }
  }
  report(event) {
    try { this.observe(event); } catch { /* Observers never change a delivery outcome. */ }
  }
  present(job) {
    const status = deliveryStatus(job);
    const label = this.harnessLabel(job);
    const display = this.displayStatus(job, status);
    const automation = job.chain ? continuation.describe(job, status === 'sent') : null;
    const waiting = job.status === 'pending' && display === 'waiting' ? { reason: job.waitReason, nextCheckAt: job.nextAttemptAt, availability: job.availability || null } : null;
    return { ...job, harnessLabel: label, risk: this.risk(job), deliveryStatus: status, displayStatus: display, automation, waiting,
      note: status === 'unconfirmed' ? 'Delivery could not be confirmed. Check delivery before scheduling again.' : status === 'failed' ? job.error?.message || 'This delivery failed. Check connection settings and API compatibility.' : status === 'sent' && !job.chain ? `Sent to ${label}` : job.note,
      effectiveAt: new Date(this.dueAt(job)).toISOString(), needsAttention: this.needsAttention(job),
      canStop: job.chain ? ['active', 'paused'].includes(job.chain.state) : job.status === 'pending',
      canResume: job.chain?.state === 'paused' && status !== 'unconfirmed',
      deliveryLabel: ({ paused: 'Paused', stopped: 'Stopped', finished: 'Finished', waiting: this.waitLabel(job), running: 'Agent working', pending: 'Scheduled', dispatching: 'Sending', sent: `Sent to ${label}`, failed: 'Failed', canceled: 'Canceled', unconfirmed: 'Delivery unconfirmed' })[display] };
  }
  list({ view = 'all', status, offset = 0, limit = 100 } = {}) {
    if (!['all', 'upcoming', 'history'].includes(view) || (status && !['pending','dispatching','sent','failed','canceled','unconfirmed'].includes(status))) throw new Error('Invalid schedule filter.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid pagination.');
    const filtered = this.jobs.filter((job) => (!status || deliveryStatus(job) === status) && (view === 'all' || (view === 'history') !== this.upcoming(job)));
    filtered.sort((a,b) => view === 'upcoming' ? this.dueAt(a) - this.dueAt(b) || a.id.localeCompare(b.id) : Date.parse(b.updatedAt || b.createdAt || b.scheduleAt) - Date.parse(a.updatedAt || a.createdAt || a.scheduleAt) || a.id.localeCompare(b.id));
    return { jobs: filtered.slice(offset, offset + limit).map((job) => this.present(job)), total: filtered.length, unacknowledgedFailures: this.jobs.filter((job) => this.needsAttention(job)).length };
  }
  // Work that is scheduled, waiting for availability, being sent, or still
  // running in a harness, including every active automatic continuation.
  // Consumers such as keep-awake use this instead of reading job records.
  // A running turn is followed for at most 24 hours from its send. The send attempt time counts
  // when only reconciliation confirmed the delivery, so confirming an old send never starts a new day of tracking.
  trackingExpired(job) {
    return this.now() - Date.parse(job.dispatchedAt || job.dispatchAttemptedAt || job.confirmedAt || job.turn?.updatedAt) > MAX_TURN_TRACKING_MS;
  }
  activeWork() {
    // A send already in flight stays active work even after its continuation was stopped.
    // A turn past the tracking limit is not, even before the next poll records it as unknown.
    return this.jobs.filter((job) => this.upcoming(job) || job.status === 'dispatching' || (job.turn?.state === 'running' && !this.trackingExpired(job))).map((job) => {
      const adapter = this.knownAdapter(job);
      const summary = job.chain ? continuation.describe(job, deliveryStatus(job) === 'sent') : null;
      return { jobId: job.id, harness: job.harness, conversationId: job.threadId,
        phase: job.status === 'pending' ? (this.waiting(job) ? 'waiting' : 'scheduled') : job.status === 'dispatching' ? 'sending' : 'running',
        effectiveAt: new Date(this.dueAt(job)).toISOString(), nextCheckAt: job.status === 'pending' ? job.nextAttemptAt || null : null,
        requiresUnlockedScreen: adapter?.capabilities.requiresUnlockedScreen === true,
        chain: summary && { state: summary.state, limit: summary.limit, unlimited: summary.unlimited, currentTurn: summary.currentTurn, sentTurns: summary.sentTurns, remainingTurns: summary.remainingTurns } };
    });
  }
  patch(job, patch) {
    const previous = { ...job };
    if (patch.status && !patch.deliveryCertainty) patch = { ...patch, deliveryCertainty: patch.status === 'sent' ? 'delivered' : ['dispatching', 'unconfirmed'].includes(patch.status) ? 'unknown' : 'not-delivered' };
    // Any confirmed delivery on a completion-capable harness starts turn tracking, including reconciliation.
    if (patch.deliveryCertainty === 'delivered' && !job.turn && !patch.turn && this.harnesses.has(job.harness) && this.adapterFor(job).capabilities.canDetectCompletion) {
      patch = { ...patch, turn: { state: 'running', turnId: null, completedAt: null, error: null, usageLimit: null, updatedAt: this.timestamp() } };
    }
    Object.assign(job, patch, { updatedAt: this.timestamp() });
    try { this.save(); } catch (error) {
      for (const key of Object.keys(job)) delete job[key];
      Object.assign(job, previous); throw error;
    }
  }
  cancelTimer(id) { this.generations.set(id, (this.generations.get(id) || 0) + 1); this.timers.get(id)?.cancel(); this.timers.delete(id); }
  schedule(job) {
    this.cancelTimer(job.id);
    if (!this.armed(job) || !this.scheduleTimer) return;
    const when = Math.max(this.dueAt(job), this.now()+250);
    const generation = this.generations.get(job.id);
    this.timers.set(job.id, this.scheduleTimer(new Date(when), () => {
      if (this.generations.get(job.id) === generation) void this.run(job.id).catch(() => {
        this.tell('Schedule could not be updated', 'Local schedule storage is unavailable. Check disk space and restart the app.');
      });
    }));
  }
  schedulePending() { this.jobs.forEach((job) => this.schedule(job)); }
  chainPatch(job, state, code, reason) { return { chain: continuation.halt(job.chain, state, code, reason, this.timestamp()) }; }
  // Fields that make the job's current turn a fresh, unsent turn with new IDs,
  // so a new delivery can never be mistaken for an earlier one.
  freshTurn(job, { waitReason, limitResetsAt = null, nextAttemptAt = null, activitySince, note }) {
    const now = this.timestamp();
    return { status: 'pending', deliveryCertainty: 'not-delivered', messageId: this.uuid(), commandId: this.uuid(), deliveryKey: null,
      dispatchAttemptedAt: null, dispatchedAt: null, confirmedAt: null, lastReconciledAt: null, lateBySeconds: 0, turn: null, error: null,
      scheduleAt: now, utcOffsetMinutes: utcOffsetMinutes(now, job.timeZone || 'UTC'), activitySince: activitySince || now, baselineUserTurnAt: null,
      waitReason, limitResetsAt, nextAttemptAt, availability: null, availabilityChecks: 0, note };
  }
  async create(incoming) {
    const automation = continuation.validateAutomation(incoming || {});
    const input = validateScheduleInput(incoming, { requireTime: automation.trigger !== 'available' });
    const zone = timezone(incoming.timeZone);
    const harness = harnessId(incoming.harness);
    const adapter = this.harnesses.get(harness);
    continuation.assertSupported(adapter, automation);
    const state = await adapter.inspectConversation({ conversationId: input.threadId, deliveryKey: null }, { purpose: 'schedule' });
    if (state.archived) throw new Error(`That ${adapter.conversationNoun} is archived. Choose another ${adapter.conversationNoun}.`);
    const createdAt = this.timestamp();
    // Revalidate after the asynchronous baseline read.
    if (input.whenISO) validateScheduleInput(input);
    const scheduleAt = input.whenISO || createdAt;
    const job = { id: this.uuid(), harness, commandId: this.uuid(), messageId: this.uuid(), threadId: input.threadId, message: input.message, scheduleAt,
      status: 'pending', deliveryCertainty: 'not-delivered', createdAt, updatedAt: this.timestamp(), activitySince: createdAt,
      baselineUserTurnAt: state.latestUserActivityAt,
      threadTitle: state.title, projectId: state.projectId, projectName: state.projectName,
      bufferSeconds: this.bufferSeconds, timeZone: zone, utcOffsetMinutes: utcOffsetMinutes(scheduleAt, zone),
      acknowledgedAt: null, note: '', trigger: automation.trigger,
      chain: continuation.needsChain(automation) ? continuation.newChain(automation.limit, createdAt) : null,
      waitReason: automation.trigger === 'time' ? null : 'availability', limitResetsAt: null, nextAttemptAt: null, availability: null, availabilityChecks: 0 };
    this.jobs.push(job);
    try { this.save(); } catch (error) { this.jobs.pop(); throw error; }
    this.schedule(job); return this.present(job);
  }
  edit(id, incoming) {
    const job = this.get(id);
    if (job.status !== 'pending') throw Object.assign(new Error('Only scheduled messages can be edited.'), { code: 'invalid_state' });
    if (job.chain && (job.chain.state !== 'active' || job.chain.previousTurns > 0)) throw Object.assign(new Error('This continuation has already started. Stop it and schedule again to change it.'), { code: 'invalid_state' });
    const automation = hasAutomationFields(incoming) ? continuation.validateAutomation(incoming) : { trigger: job.trigger || 'time', limit: job.chain ? job.chain.limit : 1 };
    if (this.harnesses.has(job.harness)) continuation.assertSupported(this.adapterFor(job), automation);
    const input = validateScheduleInput({ ...incoming, threadId: job.threadId }, { requireTime: automation.trigger !== 'available' });
    const zone = timezone(incoming.timeZone || job.timeZone);
    const scheduleAt = input.whenISO || (job.trigger === 'available' ? job.scheduleAt : this.timestamp());
    const chain = continuation.needsChain(automation) ? { ...(job.chain || continuation.newChain(automation.limit, this.timestamp())), limit: automation.limit } : null;
    this.patch(job, { message: input.message, scheduleAt, timeZone: zone, utcOffsetMinutes: utcOffsetMinutes(scheduleAt, zone), trigger: automation.trigger, chain,
      waitReason: automation.trigger === 'time' ? null : 'availability', nextAttemptAt: null, availabilityChecks: 0 });
    this.schedule(job); return this.present(job);
  }
  cancel(id) {
    const job = this.get(id);
    if (job.status !== 'pending') throw Object.assign(new Error('Only scheduled messages can be canceled.'), { code: 'invalid_state' });
    this.patch(job, { status: 'canceled', note: 'Canceled by user', ...(job.chain && ['active', 'paused'].includes(job.chain.state) ? this.chainPatch(job, 'stopped', 'stopped_by_user', 'Canceled by you.') : {}) });
    this.cancelTimer(id); return this.present(job);
  }
  // Stops a scheduled message or an automatic continuation. It never sends and
  // is safe to call at any point; an in-flight send finishes, but nothing
  // further is sent. This is the stable entry point for the UI, tray and remote control.
  stop(id) {
    const job = this.get(id);
    if (!job.chain) {
      if (job.status === 'pending') return this.cancel(id);
      throw Object.assign(new Error('Only scheduled messages and active continuations can be stopped.'), { code: 'invalid_state' });
    }
    if (!['active', 'paused'].includes(job.chain.state)) throw Object.assign(new Error('This continuation has already ended.'), { code: 'invalid_state' });
    const working = job.turn?.state === 'running' ? ` The current turn keeps running in ${this.harnessLabel(job)}, but no further message will be sent.` : '';
    this.patch(job, { ...this.chainPatch(job, 'stopped', 'stopped_by_user', `Stopped by you.${working}`), ...(job.status === 'pending' ? { status: 'canceled', note: 'Stopped by user' } : {}) });
    this.cancelTimer(id); return this.present(job);
  }
  // Stops every active or paused automatic continuation.
  stopAll() {
    const ids = this.jobs.filter((job) => job.chain && ['active', 'paused'].includes(job.chain.state)).map((job) => job.id);
    return { stopped: ids.map((id) => this.stop(id).id) };
  }
  // Resumes a paused continuation from where it stopped. The turn limit keeps
  // counting from the turns already delivered; nothing is ever resent.
  resumeChain(id) {
    const job = this.get(id);
    if (job.chain?.state !== 'paused') throw Object.assign(new Error('Only paused continuations can be resumed.'), { code: 'invalid_state' });
    const status = deliveryStatus(job);
    if (status === 'unconfirmed') throw Object.assign(new Error('Check delivery before resuming. The last message may already have arrived.'), { code: 'invalid_state' });
    if (this.running.has(id)) throw Object.assign(new Error('This continuation is busy. Try again in a moment.'), { code: 'invalid_state' });
    const now = this.timestamp();
    const chain = { ...job.chain, state: 'active', reasonCode: null, reason: '', changedAt: now, quickStreak: 0 };
    const acknowledged = { acknowledgedAt: job.acknowledgedAt || now };
    if (status === 'pending') {
      this.patch(job, { chain, ...acknowledged, scheduleAt: now, utcOffsetMinutes: utcOffsetMinutes(now, job.timeZone || 'UTC'), nextAttemptAt: null, availabilityChecks: 0, activitySince: now, baselineUserTurnAt: null, note: 'Resumed' });
    } else if (status === 'failed') {
      this.patch(job, { chain, ...acknowledged, ...this.freshTurn(job, { waitReason: job.waitReason === 'availability' ? 'availability' : 'continuation', note: 'Resumed after a failed send' }) });
    } else if (status === 'sent' && (!job.turn || job.turn.state === 'running')) {
      if (!this.knownAdapter(job)?.capabilities.canDetectCompletion) throw Object.assign(new Error(`${this.harnessLabel(job)} cannot report when this turn finishes, so the continuation cannot resume. Schedule again instead.`), { code: 'invalid_state' });
      this.patch(job, { chain, ...acknowledged, turn: job.turn || runningTurn(null, now) });
      void this.pollTurns().catch(() => {});
    } else if (status === 'sent') {
      const decision = continuation.afterTurn({ ...job, chain }, job.turn, this.now(), { force: true });
      if (decision.kind === 'finish') this.patch(job, { ...acknowledged, chain: continuation.halt(chain, 'finished', decision.code, decision.reason, now) });
      else this.patch(job, { ...acknowledged, ...this.nextTurnPatch({ ...job, chain }, job.turn, decision, now) });
    } else throw Object.assign(new Error('This continuation cannot be resumed.'), { code: 'invalid_state' });
    this.schedule(job); return this.present(job);
  }
  acknowledge(id) {
    const job = this.get(id);
    if (!['failed','unconfirmed'].includes(deliveryStatus(job)) && job.chain?.state !== 'paused') throw Object.assign(new Error('Only delivery problems and paused continuations can be acknowledged.'), { code: 'invalid_state' });
    this.patch(job, { acknowledgedAt: job.acknowledgedAt || this.timestamp() }); return this.present(job);
  }
  scheduleAgain(id) {
    const job = this.get(id);
    if (!terminal.has(job.status) || this.upcoming(job) || !['delivered', 'not-delivered'].includes(job.deliveryCertainty)) throw new Error('Confirm the previous delivery before scheduling again.');
    return { harness: job.harness, threadId: job.threadId, message: job.message, timeZone: job.timeZone,
      trigger: job.trigger || 'time', turnLimit: job.chain?.limit ?? 1, continuous: job.chain ? job.chain.limit === null : false };
  }
  async reconcile(id) {
    const job = this.get(id);
    if (deliveryStatus(job) !== 'unconfirmed') throw new Error('Only unconfirmed deliveries need reconciliation.');
    const { delivered } = await this.adapterFor(job).findDelivery(turnRef(job));
    if (delivered) this.patch(job, { ...(job.status === 'failed' ? {} : { status: 'sent', note: `Message confirmed in ${this.harnessLabel(job)}` }), deliveryCertainty: 'delivered', confirmedAt: this.timestamp(), error: null,
      ...(job.chain?.state === 'paused' ? this.chainPatch(job, 'paused', 'delivery_confirmed', 'Delivery was confirmed. Resume to wait for this turn to finish and keep continuing.') : {}) });
    else this.patch(job, { lastReconciledAt: this.timestamp() });
    return this.present(job);
  }
  // Startup reconciliation. Nothing here sends: interrupted sends become
  // unconfirmed, and continuations whose state cannot be trusted pause.
  recover() {
    const now = this.timestamp();
    for (const job of this.jobs) {
      if (job.status === 'dispatching') {
        // Every send persists dispatchAttemptedAt before it starts (bare version 1 arrays excepted), so without it nothing was sent.
        // A stopped continuation interrupted that early is final rather than pending forever.
        const unsent = !job.dispatchAttemptedAt && (this.attemptsRecorded || job.chain);
        if (unsent && job.chain && job.chain.state !== 'active') Object.assign(job, { status: 'canceled', deliveryCertainty: 'not-delivered', note: 'Stopped by user', updatedAt: now });
        else if (unsent) Object.assign(job, { status: 'pending', deliveryCertainty: 'not-delivered', note: job.chain ? 'The app stopped before sending. The turn will be checked again.' : 'Sending was interrupted before the message was sent, so it will be sent again.', updatedAt: now });
        else Object.assign(job, { status: 'unconfirmed', deliveryCertainty: 'unknown', note: 'Dispatch was interrupted. Check delivery before scheduling again.', updatedAt: now });
      }
      if (job.chain?.state !== 'active') continue;
      const status = deliveryStatus(job);
      if (status === 'unconfirmed') Object.assign(job, { acknowledgedAt: null, ...this.chainPatch(job, 'paused', 'delivery_unconfirmed', 'The app stopped while sending. Check delivery before resuming.') });
      else if (status === 'failed') Object.assign(job, { acknowledgedAt: null, ...this.chainPatch(job, 'paused', 'send_failed', 'The last send failed. Resume to try again.') });
      else if (status === 'canceled') Object.assign(job, this.chainPatch(job, 'stopped', 'canceled', job.note || 'Canceled.'));
      else if (status === 'sent' && !job.turn) Object.assign(job, { acknowledgedAt: null, ...this.chainPatch(job, 'paused', 'turn_unknown', 'The app cannot tell whether the last turn finished. Resume to keep continuing.') });
      else if (status === 'sent' && finishedTurn.has(job.turn.state)) Object.assign(job, this.turnFinishedPatch(job, job.turn));
    }
    this.save();
  }
  // Called when the Mac is unlocked: continuations waiting only for the unlock are checked now.
  retryAfterUnlock() {
    const ids = this.jobs.filter((job) => this.armed(job) && job.availability?.reason === continuation.SCREEN_LOCKED && job.nextAttemptAt).map((job) => job.id);
    for (const id of ids) this.patch(this.get(id), { nextAttemptAt: null });
    return Promise.all(ids.map((id) => this.run(id)));
  }
  resume() { return Promise.all(this.jobs.filter((job) => this.armed(job) && this.dueAt(job) <= this.now()).map((job) => this.run(job.id))); }
  // The next turn of a chain, with the finished turn archived in its history.
  nextTurnPatch(job, turn, decision, now = this.timestamp()) {
    const resets = Date.parse(decision.limitResetsAt);
    const nextAttemptAt = Number.isFinite(resets) ? new Date(resets + job.bufferSeconds * 1000).toISOString() :
      decision.waitReason === 'limit-reset' ? new Date(this.now() + continuation.LIMIT_RETRY_MS).toISOString() : null;
    const chain = { ...job.chain, previousTurns: job.chain.previousTurns + 1, limitedTurns: (job.chain.limitedTurns || 0) + (decision.limited ? 1 : 0),
      quickStreak: decision.quickStreak || 0, limitStreak: decision.limitStreak || 0,
      history: [...job.chain.history, continuation.historyEntry(job, turn)].slice(-continuation.HISTORY_LIMIT) };
    const note = decision.waitReason === 'limit-reset' ? 'Waiting for the usage limit to reset before the next turn' : 'Next turn queued';
    return { ...this.freshTurn(job, { waitReason: decision.waitReason, limitResetsAt: decision.limitResetsAt, nextAttemptAt, activitySince: continuation.activitySinceAfter(job, now), note }), chain };
  }
  // Everything that changes when the current turn of a chain finishes, as one patch.
  turnFinishedPatch(job, turn) {
    const decision = continuation.afterTurn(job, turn, this.now());
    if (decision.kind === 'next') return { ...this.nextTurnPatch(job, turn, decision), turn: null };
    if (decision.kind === 'finish') return { turn, ...this.chainPatch(job, 'finished', decision.code, decision.reason) };
    if (decision.kind === 'pause') return { turn, acknowledgedAt: null, ...this.chainPatch(job, 'paused', decision.code, decision.reason) };
    return { turn };
  }
  // Records a harness-reported turn outcome once; finished outcomes are final.
  // `messageId` ties an asynchronous outcome to the turn it was requested for.
  recordTurn(id, value, messageId) {
    const job = this.get(id);
    if (messageId && job.messageId !== messageId) return this.present(job);
    if (!job.turn || finishedTurn.has(job.turn.state)) return this.present(job);
    const outcome = turnOutcome(value);
    outcome.turnId ||= job.turn.turnId;
    if (outcome.state === 'running' && isDeepStrictEqual(outcome, turnOutcome(job.turn))) return this.present(job);
    const turn = { ...job.turn, ...outcome, turnId: outcome.turnId || job.turn.turnId, updatedAt: this.timestamp() };
    const label = this.harnessLabel(job);
    if (job.chain?.state === 'active' && finishedTurn.has(outcome.state)) {
      const patch = this.turnFinishedPatch(job, turn);
      this.patch(job, patch);
      if (patch.chain?.state === 'finished') this.tell('Continuation finished', `${label}: ${patch.chain.reason}`);
      else if (patch.chain?.state === 'paused') this.tell('Continuation paused', `${label}: ${patch.chain.reason}`);
      this.schedule(job);
      return this.present(job);
    }
    this.patch(job, { turn });
    if (finishedTurn.has(outcome.state) && outcome.state !== 'unknown') {
      if (outcome.state === 'completed') this.tell('Agent turn finished', `${label} finished the scheduled turn.`);
      else this.tell(outcome.usageLimit ? 'Agent reached a usage limit' : 'Agent turn did not finish', outcome.usageLimit?.message || outcome.error?.message || `${label} stopped before finishing the scheduled turn.`);
    }
    return this.present(job);
  }
  // Polls harnesses that report completion for every turn still running.
  async pollTurns() {
    const stale = this.jobs.filter((job) => job.turn?.state === 'running' && this.trackingExpired(job));
    for (const job of stale) this.recordTurn(job.id, { state: 'unknown', error: { code: 'tracking_expired', message: 'The agent turn could not be followed to completion.' } });
    const running = this.jobs.filter((job) => job.turn?.state === 'running' && this.harnesses.has(job.harness));
    await Promise.all(running.map(async (job) => {
      const adapter = this.adapterFor(job);
      if (typeof adapter.checkTurn !== 'function') return;
      const messageId = job.messageId;
      let outcome;
      try { outcome = await adapter.checkTurn(turnRef(job)); } catch { return; }
      this.recordTurn(job.id, outcome, messageId);
    }));
  }
  async run(id) {
    const job = this.get(id);
    if (!this.armed(job) || this.running.has(id)) return;
    if (this.dueAt(job) > this.now()) { this.schedule(job); return; }
    this.running.add(id); this.cancelTimer(id);
    try {
      const gated = this.gated(job);
      if (gated) {
        if (!(await this.checkAvailability(job))) return;
        // The schedule may have been stopped or edited while availability was read.
        if (!this.armed(job)) return;
        if (this.dueAt(job) > this.now()) { this.schedule(job); return; }
      }
      await this.dispatch(job, { gated });
    } finally { this.running.delete(id); }
  }
  // Reads availability for a gated turn while it is still pending, so an
  // interrupted check never looks like an interrupted send. Returns true to send now.
  async checkAvailability(job) {
    let reading;
    try { reading = normaliseAvailability(await this.adapterFor(job).probeAvailability()); }
    catch { reading = normaliseAvailability({ state: 'unavailable', reason: continuation.CHECK_FAILED, checkedAt: this.timestamp() }); }
    if (!this.armed(job)) return false;
    const availability = { state: reading.state, resetsAt: reading.resetsAt, reason: reading.reason.slice(0, 300), source: reading.source, checkedAt: reading.checkedAt };
    const decision = continuation.gateDecision({ availability, now: this.now(), bufferMs: job.bufferSeconds * 1000, attempts: job.availabilityChecks });
    if (decision.proceed) { this.patch(job, { availability }); return true; }
    this.patch(job, { availability, nextAttemptAt: new Date(decision.nextAttemptAt).toISOString(), availabilityChecks: decision.backoff ? job.availabilityChecks + 1 : 0, note: decision.note });
    this.schedule(job);
    return false;
  }
  // A continuation stopped while its turn was being prepared is canceled before anything is sent.
  stoppedMidway(job) {
    if (!job.chain || job.chain.state === 'active') return false;
    this.patch(job, { status: 'canceled', note: 'Stopped by user' });
    return true;
  }
  // Records why a turn is waiting when the agent is busy, so the latest cause replaces an earlier one such as a locked screen.
  busyReading(message) {
    return { state: 'unavailable', resetsAt: null, reason: continuation.CONVERSATION_BUSY, detail: String(message || '').slice(0, 300), source: 'reported', checkedAt: this.timestamp() };
  }
  // Pauses an automatic continuation before sending; the turn stays pending and unsent.
  pauseBeforeSend(job, code, reason, extra = {}) {
    this.patch(job, { ...extra, status: 'pending', note: reason, acknowledgedAt: null, ...this.chainPatch(job, 'paused', code, reason) });
    this.tell('Continuation paused', `${this.harnessLabel(job)}: ${reason}`);
  }
  async dispatch(job, { gated }) {
    const id = job.id;
    let dispatched = false;
    const noun = this.noun(job);
    try {
      this.patch(job, { status: 'dispatching', note: `Checking ${noun} before dispatch`, lateBySeconds: Math.max(0, Math.floor((this.now()-this.dueAt(job))/1000)) });
      const adapter = this.adapterFor(job);
      const label = adapter.label;
      const tracksTurn = adapter.capabilities.canDetectCompletion;
      const state = await adapter.inspectConversation(turnRef(job), { purpose: 'dispatch' });
      if (this.stoppedMidway(job)) return;
      if (state.delivered) {
        this.patch(job, { status: 'sent', note: `Message was already present in the ${noun}`, confirmedAt: this.timestamp(), nextAttemptAt: null, ...(tracksTurn ? { turn: runningTurn(null, this.timestamp()) } : {}) });
        return;
      }
      if (state.archived) { this.patch(job, { status: 'canceled', note: `${capitalise(noun)} is archived`, ...(job.chain ? this.chainPatch(job, 'stopped', 'archived', `The ${noun} was archived.`) : {}) }); return; }
      const latest = Date.parse(state.latestUserActivityAt);
      const since = Date.parse(job.activitySince);
      const baseline = Date.parse(job.baselineUserTurnAt);
      if (Number.isFinite(latest) && Number.isFinite(since) && latest > since && (!Number.isFinite(baseline) || latest > baseline)) {
        if (job.chain) this.pauseBeforeSend(job, 'user_activity', `New user activity appeared in the ${noun}. Resume to keep continuing.`);
        else this.patch(job, { status: 'canceled', note: 'New user activity appeared after this schedule was created' });
        return;
      }
      if (job.chain && state.awaitingInput === true) { this.pauseBeforeSend(job, 'awaiting_input', `${label} is waiting for your input. Answer it, then resume.`); return; }
      if (job.chain && state.busy === true) {
        const delay = continuation.backoff(job.availabilityChecks);
        this.patch(job, { status: 'pending', nextAttemptAt: new Date(this.now() + delay).toISOString(), availabilityChecks: job.availabilityChecks + 1, availability: this.busyReading(`${label} is still working.`), note: `${label} is still working. Checking again in ${Math.round(delay / 60_000)} min.` });
        this.schedule(job);
        return;
      }
      // Continuations are handled above. A one-off message must not answer a question or approval, or land in the middle of work.
      // Unknown (null) never blocks.
      const refuse = (code, message) => {
        const error = { code, message, details: {}, deliveryUncertain: false };
        this.patch(job, { status: 'failed', note: message, error, acknowledgedAt: null });
        try { this.notify('Scheduled message not sent', message); } catch { /* Outcome is already committed. */ }
      };
      if (state.awaitingInput === true) { refuse('awaiting_input', `${label} is waiting for your answer in this ${noun}. The message was not sent.`); return; }
      if (state.busy === true) { refuse('conversation_busy', `${label} is still working in this ${noun}. The message was not sent.`); return; }
      if (!gated && adapter.capabilities.canDetectUsageLimit) {
        const available = await adapter.probeAvailability().catch(() => null);
        if (this.stoppedMidway(job)) return;
        // A known future reset blocks; without one, only a limit the harness itself reported does.
        const resetsAt = Date.parse(available?.resetsAt);
        if (available?.state === 'limited' && (Number.isFinite(resetsAt) ? resetsAt > this.now() : available.source === 'reported')) {
          const message = `${label} reports a usage limit${available.resetsAt ? ` until ${available.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : ''}. The message was not sent.`;
          const error = { code: 'usage_limited', message, details: { resetsAt: available.resetsAt, source: available.source }, deliveryUncertain: false };
          this.patch(job, { status: 'failed', note: message, error, acknowledgedAt: null, ...(job.chain?.state === 'active' ? this.chainPatch(job, 'paused', 'usage_limited', `${message} Resume to wait for the limit to reset.`) : {}) });
          this.tell('Scheduled message not sent', message);
          return;
        }
      }
      if (this.stoppedMidway(job)) return;
      const prepared = await adapter.prepareTurn(turnRef(job), state);
      if (this.stoppedMidway(job)) return;
      // Persist the guard before submitting so a restart never automatically resends.
      this.patch(job, { dispatchAttemptedAt: this.timestamp(), ...(prepared.deliveryKey && prepared.deliveryKey !== job.messageId ? { deliveryKey: prepared.deliveryKey } : {}) });
      dispatched = true;
      const result = await adapter.submitTurn(turnRef(job), prepared.plan);
      this.patch(job, { status: 'sent', note: `Sent to ${label}`, dispatchedAt: this.timestamp(), error: null, nextAttemptAt: null, availabilityChecks: 0,
        ...(tracksTurn ? { turn: runningTurn(result?.turnId, this.timestamp()) } : {}) });
      // Follow-up turns of a continuation stay quiet; pauses and the finish are announced.
      if (!job.chain || job.chain.previousTurns === 0) this.tell(`Sent to ${label}`, job.chain ? 'Your automatic continuation has started.' : 'Your scheduled message was delivered.');
      this.report({ harness: job.harness, jobId: job.id, status: 'sent', error: null });
      if (tracksTurn && result?.completion) {
        const messageId = job.messageId;
        Promise.resolve(result.completion).then((outcome) => this.recordTurn(id, outcome, messageId), () => this.pollTurns()).catch(() => { /* Storage failures surface elsewhere. */ });
      }
    } catch (error) {
      if (!dispatched && this.stoppedMidway(job)) return;
      const info = toErrorInfo(error);
      const pause = job.chain?.state === 'active';
      if (!dispatched && (info.code === 'conversation_not_found' || info.details?.status === 404)) {
        this.patch(job, { status: 'canceled', note: `${capitalise(noun)} is no longer available`, error: null, ...(pause ? this.chainPatch(job, 'stopped', 'missing', `The ${noun} is no longer available.`) : {}) }); return;
      }
      // A locked Mac or a busy conversation is a certain non-delivery: the
      // continuation keeps the same unsent turn, checks again later, and nothing is counted.
      if (pause && !info.deliveryUncertain && [continuation.SCREEN_LOCKED, 'conversation_busy'].includes(info.code)) {
        const locked = info.code === continuation.SCREEN_LOCKED;
        const delay = locked ? continuation.LOCKED_RETRY_MS : continuation.backoff(job.availabilityChecks);
        this.patch(job, { status: 'pending', dispatchAttemptedAt: null, nextAttemptAt: new Date(this.now() + delay).toISOString(), error: null,
          note: locked ? 'Waiting for the Mac to be unlocked.' : `${info.message} Checking again in ${Math.round(delay / 60_000)} min.`,
          ...(locked ? { availability: { state: 'unavailable', resetsAt: null, reason: continuation.SCREEN_LOCKED, source: 'reported', checkedAt: this.timestamp() } } : { availabilityChecks: job.availabilityChecks + 1, availability: this.busyReading(info.message) }) });
        this.schedule(job);
        return;
      }
      // A certain refusal at a usage limit is waited out like a limit read before sending,
      // except for a timed first turn, which fails and pauses as documented.
      if (pause && !info.deliveryUncertain && info.code === 'usage_limited' && job.waitReason) {
        const resets = Date.parse(info.details?.resetsAt);
        const known = Number.isFinite(resets) && resets > this.now();
        const delay = continuation.backoff(job.availabilityChecks);
        this.patch(job, { status: 'pending', dispatchAttemptedAt: null, error: null, nextAttemptAt: new Date(known ? resets + job.bufferSeconds * 1000 : this.now() + delay).toISOString(),
          availability: { state: 'limited', resetsAt: known ? new Date(resets).toISOString() : null, reason: info.message.slice(0, 300), source: 'reported', checkedAt: this.timestamp() },
          availabilityChecks: known ? 0 : job.availabilityChecks + 1,
          note: known ? `${info.message} Waiting for the limit to reset.` : `${info.message} Checking again in ${Math.round(delay / 60_000)} min.` });
        this.schedule(job);
        return;
      }
      // The agent is waiting for the user: a certain non-delivery that needs them, so the
      // continuation pauses with the same unsent turn, exactly as when the inspection reports it.
      if (pause && !info.deliveryUncertain && info.code === 'awaiting_input') {
        this.pauseBeforeSend(job, 'awaiting_input', `${info.message} Answer it, then resume.`, { dispatchAttemptedAt: null, error: null });
        return;
      }
      if (pause && info.code === 'owned_by_other_harness') {
        // Name the owner only when it is a harness in this build; otherwise the adapter's own message says who owns it.
        const owner = typeof info.details?.harness === 'string' && this.harnesses.has(info.details.harness) ? this.harnesses.get(info.details.harness).label : '';
        const reason = owner ? `This ${noun} belongs to ${owner}, so it cannot be continued through ${this.harnessLabel(job)}. Schedule it from ${owner} instead.` : `${info.message} The continuation stopped.`;
        this.patch(job, { status: 'failed', note: info.message, error: info, acknowledgedAt: null, ...this.chainPatch(job, 'stopped', 'owned_by_other_harness', reason) });
        this.tell('Continuation stopped', info.message);
        return;
      }
      const uncertain = dispatched && (info.deliveryUncertain || info.code === 'unexpected');
      this.patch(job, { status: uncertain ? 'unconfirmed' : 'failed', note: info.message, error: info, acknowledgedAt: null,
        ...(pause ? this.chainPatch(job, 'paused', uncertain ? 'delivery_unconfirmed' : 'send_failed', uncertain ? 'Delivery could not be confirmed, so nothing further was sent. Check delivery before resuming.' : `The message was not sent: ${info.message} Resume to try again.`) : {}) });
      this.tell(uncertain ? 'Delivery unconfirmed' : info.code === 'app_version_unsupported' ? 'App version not supported yet' : 'Scheduled message failed', info.message);
      this.report({ harness: job.harness, jobId: job.id, status: uncertain ? 'unconfirmed' : 'failed', error: info });
    }
  }
}
module.exports = { JobService, STORE_VERSION, migrateJobs, turnRef };
