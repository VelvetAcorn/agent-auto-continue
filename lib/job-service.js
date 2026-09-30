'use strict';

const { randomUUID } = require('node:crypto');
const { readJobs, validateScheduleInput } = require('./model');
const { toErrorInfo } = require('./harnesses/errors');
const { turnOutcome } = require('./harnesses/contract');
const { DEFAULT_HARNESS, createHarnessRegistry } = require('./harnesses/registry');
const { createT3Harness } = require('./harnesses/t3');

const STORE_VERSION = 3;
const terminal = new Set(['sent', 'failed', 'canceled', 'unconfirmed']);
const finishedTurn = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const HARNESS_ID = /^[a-z][a-z0-9-]{0,31}$/;

function deliveryStatus(job) {
  if (!terminal.has(job.status)) return job.status;
  if (job.deliveryCertainty === 'unknown') return 'unconfirmed';
  if (job.deliveryCertainty === 'delivered') return 'sent';
  return job.status;
}
// Version 3 adds per-job harnesses. Older app versions refuse it rather than
// sending another harness's conversation ID to T3 Code.
function migrateJobs(value, bufferSeconds = 5) {
  if (!Array.isArray(value) && (!value || ![2, STORE_VERSION].includes(value.version) || !Array.isArray(value.jobs))) {
    throw new Error('The local schedule file uses an unsupported format. Restore a compatible backup or open it with the app version that created it. Existing data has not been changed.');
  }
  const rows = Array.isArray(value) ? value : value.jobs;
  const valid = readJobs(rows).filter((job) => job.harness === undefined || HARNESS_ID.test(job.harness));
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
    acknowledgedAt: job.acknowledgedAt || null
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

// The read-only view of a job that adapters receive. It never exposes persistence.
function turnRef(job) {
  return Object.freeze({
    jobId: job.id, harness: job.harness, conversationId: job.threadId, message: job.message,
    messageId: job.messageId, commandId: job.commandId, deliveryKey: job.deliveryKey || job.messageId,
    createdAt: job.createdAt || null, dispatchAttemptedAt: job.dispatchAttemptedAt || null, turnId: job.turn?.turnId || null
  });
}

class JobService {
  constructor({ jobs = [], bufferSeconds = 5, api, harnesses, persist = () => {}, onChange = () => {}, notify = () => {}, scheduleTimer, now = () => Date.now(), uuid = randomUUID }) {
    this.jobs = migrateJobs(jobs, bufferSeconds);
    // Callers that only supply a T3 API client keep the original single-harness behaviour.
    this.harnesses = harnesses || createHarnessRegistry([createT3Harness({ api })]);
    Object.assign(this, { bufferSeconds, api, persist, onChange, notify, scheduleTimer, now, uuid });
    this.timers = new Map();
    this.running = new Set();
    this.generations = new Map();
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  save() { this.persist({ version: STORE_VERSION, jobs: this.jobs });
    try { this.onChange(); } catch { /* A disconnected renderer must not change delivery state. */ } }
  get(id) {
    if (typeof id !== 'string' || id.length > 512) throw new Error('Invalid schedule ID.');
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error('Schedule was not found.');
    return job;
  }
  adapterFor(job) { return this.harnesses.get(job.harness); }
  harnessLabel(job) { return this.harnesses.has(job.harness) ? this.harnesses.get(job.harness).label : job.harness; }
  noun(job) { return this.harnesses.has(job.harness) ? this.harnesses.get(job.harness).conversationNoun : 'conversation'; }
  present(job) {
    const status = deliveryStatus(job);
    const label = this.harnessLabel(job);
    return { ...job, harnessLabel: label, deliveryStatus: status, note: status === 'unconfirmed' ? 'Delivery could not be confirmed. Check delivery before scheduling again.' : status === 'failed' ? job.error?.message || 'This delivery failed. Check connection settings and API compatibility.' : status === 'sent' ? `Sent to ${label}` : job.note, effectiveAt: new Date(Date.parse(job.scheduleAt) + job.bufferSeconds * 1000).toISOString(), deliveryLabel: ({pending:'Scheduled',dispatching:'Sending',sent:`Sent to ${label}`,failed:'Failed',canceled:'Canceled',unconfirmed:'Delivery unconfirmed'})[status] };
  }
  list({ view = 'all', status, offset = 0, limit = 100 } = {}) {
    if (!['all', 'upcoming', 'history'].includes(view) || (status && !['pending','dispatching','sent','failed','canceled','unconfirmed'].includes(status))) throw new Error('Invalid schedule filter.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid pagination.');
    const filtered = this.jobs.filter((job) => (!status || deliveryStatus(job) === status) && (view === 'all' || (view === 'history' ? terminal.has(job.status) : !terminal.has(job.status))));
    filtered.sort((a,b) => view === 'upcoming' ? Date.parse(a.scheduleAt) + a.bufferSeconds*1000 - Date.parse(b.scheduleAt) - b.bufferSeconds*1000 || a.id.localeCompare(b.id) : Date.parse(b.updatedAt || b.createdAt || b.scheduleAt) - Date.parse(a.updatedAt || a.createdAt || a.scheduleAt) || a.id.localeCompare(b.id));
    return { jobs: filtered.slice(offset, offset + limit).map((job) => this.present(job)), total: filtered.length, unacknowledgedFailures: this.jobs.filter((job) => ['failed','unconfirmed'].includes(deliveryStatus(job)) && !job.acknowledgedAt).length };
  }
  // Work that is scheduled, being sent, or still running in a harness. Consumers
  // such as keep-awake use this instead of reading job records directly.
  activeWork() {
    return this.jobs.filter((job) => !terminal.has(job.status) || job.turn?.state === 'running').map((job) => {
      const adapter = this.harnesses.has(job.harness) ? this.harnesses.get(job.harness) : null;
      return { jobId: job.id, harness: job.harness, conversationId: job.threadId,
        phase: job.status === 'pending' ? 'scheduled' : job.status === 'dispatching' ? 'sending' : 'running',
        effectiveAt: new Date(Date.parse(job.scheduleAt) + job.bufferSeconds * 1000).toISOString(),
        requiresUnlockedScreen: adapter?.capabilities.requiresUnlockedScreen === true };
    });
  }
  patch(job, patch) {
    const previous = { ...job };
    if (patch.status && !patch.deliveryCertainty) patch = { ...patch, deliveryCertainty: patch.status === 'sent' ? 'delivered' : ['dispatching', 'unconfirmed'].includes(patch.status) ? 'unknown' : 'not-delivered' };
    Object.assign(job, patch, { updatedAt: this.timestamp() });
    try { this.save(); } catch (error) {
      for (const key of Object.keys(job)) delete job[key];
      Object.assign(job, previous); throw error;
    }
  }
  cancelTimer(id) { this.generations.set(id, (this.generations.get(id) || 0) + 1); this.timers.get(id)?.cancel(); this.timers.delete(id); }
  schedule(job) {
    this.cancelTimer(job.id);
    if (job.status !== 'pending' || !this.scheduleTimer) return;
    const when = Math.max(Date.parse(job.scheduleAt) + job.bufferSeconds*1000, this.now()+250);
    const generation = this.generations.get(job.id);
    this.timers.set(job.id, this.scheduleTimer(new Date(when), () => {
      if (this.generations.get(job.id) === generation) void this.run(job.id).catch(() => {
        try { this.notify('Schedule could not be updated', 'Local schedule storage is unavailable. Check disk space and restart the app.'); } catch { /* Notification unavailable. */ }
      });
    }));
  }
  schedulePending() { this.jobs.forEach((job) => this.schedule(job)); }
  async create(incoming) {
    const input = validateScheduleInput(incoming);
    const zone = timezone(incoming.timeZone);
    const harness = harnessId(incoming.harness);
    const adapter = this.harnesses.get(harness);
    const state = await adapter.inspectConversation({ conversationId: input.threadId, deliveryKey: null }, { purpose: 'schedule' });
    if (state.archived) throw new Error(`That ${adapter.conversationNoun} is archived. Choose another ${adapter.conversationNoun}.`);
    const createdAt = this.timestamp();
    // Revalidate after the asynchronous baseline read.
    validateScheduleInput(input);
    const job = { id: this.uuid(), harness, commandId: this.uuid(), messageId: this.uuid(), threadId: input.threadId, message: input.message, scheduleAt: input.whenISO,
      status: 'pending', deliveryCertainty: 'not-delivered', createdAt, updatedAt: this.timestamp(), activitySince: createdAt,
      baselineUserTurnAt: state.latestUserActivityAt,
      threadTitle: state.title, projectId: state.projectId, projectName: state.projectName,
      bufferSeconds: this.bufferSeconds, timeZone: zone, utcOffsetMinutes: utcOffsetMinutes(input.whenISO, zone),
      acknowledgedAt: null, note: '' };
    this.jobs.push(job);
    try { this.save(); } catch (error) { this.jobs.pop(); throw error; }
    this.schedule(job); return this.present(job);
  }
  edit(id, incoming) {
    const job = this.get(id);
    if (job.status !== 'pending') throw new Error('Only scheduled messages can be edited.');
    const input = validateScheduleInput({ ...incoming, threadId: job.threadId });
    const zone = timezone(incoming.timeZone || job.timeZone);
    this.patch(job, { message: input.message, scheduleAt: input.whenISO, timeZone: zone, utcOffsetMinutes: utcOffsetMinutes(input.whenISO, zone) });
    this.schedule(job); return this.present(job);
  }
  cancel(id) {
    const job = this.get(id);
    if (job.status !== 'pending') throw new Error('Only scheduled messages can be canceled.');
    this.patch(job, { status: 'canceled', note: 'Canceled by user' }); this.cancelTimer(id); return this.present(job);
  }
  acknowledge(id) {
    const job = this.get(id);
    if (!['failed','unconfirmed'].includes(deliveryStatus(job))) throw new Error('Only delivery problems can be acknowledged.');
    this.patch(job, { acknowledgedAt: job.acknowledgedAt || this.timestamp() }); return this.present(job);
  }
  scheduleAgain(id) {
    const job = this.get(id);
    if (!terminal.has(job.status) || !['delivered', 'not-delivered'].includes(job.deliveryCertainty)) throw new Error('Confirm the previous delivery before scheduling again.');
    return { harness: job.harness, threadId: job.threadId, message: job.message, timeZone: job.timeZone };
  }
  async reconcile(id) {
    const job = this.get(id);
    if (deliveryStatus(job) !== 'unconfirmed') throw new Error('Only unconfirmed deliveries need reconciliation.');
    const { delivered } = await this.adapterFor(job).findDelivery(turnRef(job));
    if (delivered) this.patch(job, { ...(job.status === 'failed' ? {} : { status: 'sent', note: `Message confirmed in ${this.harnessLabel(job)}` }), deliveryCertainty: 'delivered', confirmedAt: this.timestamp(), error: null });
    else this.patch(job, { lastReconciledAt: this.timestamp() });
    return this.present(job);
  }
  recover() {
    for (const job of this.jobs) {
      if (job.status === 'dispatching') Object.assign(job, { status: 'unconfirmed', deliveryCertainty: 'unknown', note: 'Dispatch was interrupted. Check delivery before scheduling again.', updatedAt: this.timestamp() });
    }
    this.save();
  }
  resume() { return Promise.all(this.jobs.filter((job) => job.status === 'pending' && Date.parse(job.scheduleAt) + job.bufferSeconds*1000 <= this.now()).map((job) => this.run(job.id))); }
  // Records a harness-reported turn outcome once; finished outcomes are final.
  recordTurn(id, value) {
    const job = this.get(id);
    if (!job.turn || finishedTurn.has(job.turn.state)) return this.present(job);
    const outcome = turnOutcome(value);
    if (outcome.state === job.turn.state && outcome.state === 'running') return this.present(job);
    this.patch(job, { turn: { ...job.turn, ...outcome, turnId: outcome.turnId || job.turn.turnId, updatedAt: this.timestamp() } });
    if (finishedTurn.has(outcome.state) && outcome.state !== 'unknown') {
      const label = this.harnessLabel(job);
      try {
        if (outcome.state === 'completed') this.notify('Agent turn finished', `${label} finished the scheduled turn.`);
        else this.notify(outcome.usageLimit ? 'Agent reached a usage limit' : 'Agent turn did not finish', outcome.usageLimit?.message || outcome.error?.message || `${label} stopped before finishing the scheduled turn.`);
      } catch { /* Outcome is already committed. */ }
    }
    return this.present(job);
  }
  // Polls harnesses that report completion for every turn still running.
  async pollTurns() {
    const running = this.jobs.filter((job) => job.turn?.state === 'running' && this.harnesses.has(job.harness));
    await Promise.all(running.map(async (job) => {
      const adapter = this.adapterFor(job);
      if (typeof adapter.checkTurn !== 'function') return;
      let outcome;
      try { outcome = await adapter.checkTurn(turnRef(job)); } catch { return; }
      this.recordTurn(job.id, outcome);
    }));
  }
  async run(id) {
    const job = this.get(id);
    if (job.status !== 'pending' || this.running.has(id)) return;
    if (Date.parse(job.scheduleAt) + job.bufferSeconds*1000 > this.now()) { this.schedule(job); return; }
    this.running.add(id); this.cancelTimer(id);
    let dispatched = false;
    const noun = this.noun(job);
    try {
      this.patch(job, { status: 'dispatching', note: `Checking ${noun} before dispatch`, lateBySeconds: Math.max(0, Math.floor((this.now()-Date.parse(job.scheduleAt)-job.bufferSeconds*1000)/1000)) });
      const adapter = this.adapterFor(job);
      const label = adapter.label;
      const state = await adapter.inspectConversation(turnRef(job), { purpose: 'dispatch' });
      if (state.delivered) { this.patch(job, { status: 'sent', note: `Message was already present in the ${noun}` }); return; }
      if (state.archived) { this.patch(job, { status: 'canceled', note: `${capitalise(noun)} is archived` }); return; }
      const latest = Date.parse(state.latestUserActivityAt);
      const since = Date.parse(job.activitySince);
      const baseline = Date.parse(job.baselineUserTurnAt);
      if (Number.isFinite(latest) && Number.isFinite(since) && latest > since && (!Number.isFinite(baseline) || latest > baseline)) {
        this.patch(job, { status: 'canceled', note: 'New user activity appeared after this schedule was created' }); return;
      }
      if (adapter.capabilities.canDetectUsageLimit) {
        const available = await adapter.probeAvailability().catch(() => null);
        if (available?.state === 'limited' && (!available.resetsAt || Date.parse(available.resetsAt) > this.now())) {
          const message = `${label} reports a usage limit${available.resetsAt ? ` until ${available.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : ''}. The message was not sent.`;
          const error = { code: 'usage_limited', message, details: { resetsAt: available.resetsAt, source: available.source }, deliveryUncertain: false };
          this.patch(job, { status: 'failed', note: message, error, acknowledgedAt: null });
          try { this.notify('Scheduled message not sent', message); } catch { /* Outcome is already committed. */ }
          return;
        }
      }
      const prepared = await adapter.prepareTurn(turnRef(job), state);
      // Persist the guard before submitting so a restart never automatically resends.
      this.patch(job, { dispatchAttemptedAt: this.timestamp(), ...(prepared.deliveryKey && prepared.deliveryKey !== job.messageId ? { deliveryKey: prepared.deliveryKey } : {}) });
      dispatched = true;
      const result = await adapter.submitTurn(turnRef(job), prepared.plan);
      const tracksTurn = adapter.capabilities.canDetectCompletion;
      this.patch(job, { status: 'sent', note: `Sent to ${label}`, dispatchedAt: this.timestamp(), error: null,
        ...(tracksTurn ? { turn: { state: 'running', turnId: result?.turnId || null, completedAt: null, error: null, usageLimit: null, updatedAt: this.timestamp() } } : {}) });
      try { this.notify(`Sent to ${label}`, 'Your scheduled message was delivered.'); } catch { /* Delivery is already committed. */ }
      if (tracksTurn && result?.completion) {
        result.completion.then((outcome) => this.recordTurn(id, outcome), () => this.pollTurns()).catch(() => { /* Storage failures surface elsewhere. */ });
      }
    } catch (error) {
      const info = toErrorInfo(error);
      if (!dispatched && (info.code === 'conversation_not_found' || info.details?.status === 404)) {
        this.patch(job, { status: 'canceled', note: `${capitalise(noun)} is no longer available`, error: null }); return;
      }
      const uncertain = dispatched && (info.deliveryUncertain || info.code === 'unexpected');
      this.patch(job, { status: uncertain ? 'unconfirmed' : 'failed', note: info.message, error: info, acknowledgedAt: null });
      try { this.notify(uncertain ? 'Delivery unconfirmed' : 'Scheduled message failed', info.message); } catch { /* Outcome is already committed. */ }
    } finally { this.running.delete(id); }
  }
}
module.exports = { JobService, STORE_VERSION, migrateJobs, turnRef };
