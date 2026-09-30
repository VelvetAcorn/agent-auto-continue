'use strict';

const { randomUUID } = require('node:crypto');
const { buildTurnStartCommand, findLatestUserTurnAt, hasMessageId, readJobs, validateScheduleInput } = require('./model');
const { ApiError, toErrorInfo } = require('./api-client');

function deliveryStatus(job) {
  if (!terminal.has(job.status)) return job.status;
  if (job.deliveryCertainty === 'unknown') return 'unconfirmed';
  if (job.deliveryCertainty === 'delivered') return 'sent';
  return job.status;
}
const terminal = new Set(['sent', 'failed', 'canceled', 'unconfirmed']);
function migrateJobs(value, bufferSeconds = 5) {
  if (!Array.isArray(value) && (!value || value.version !== 2 || !Array.isArray(value.jobs))) {
    throw new Error('The local schedule file uses an unsupported format. Restore a compatible backup or open it with the app version that created it. Existing data has not been changed.');
  }
  const rows = Array.isArray(value) ? value : value.jobs;
  const valid = readJobs(rows);
  if (valid.length !== rows.length) throw new Error('The local schedule file contains invalid records. Restore or repair the file before restarting. Existing data has not been changed.');
  return valid.map((job) => ({
    ...job,
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
class JobService {
  constructor({ jobs = [], bufferSeconds = 5, api, persist = () => {}, onChange = () => {}, notify = () => {}, scheduleTimer, now = () => Date.now(), uuid = randomUUID }) {
    this.jobs = migrateJobs(jobs, bufferSeconds);
    Object.assign(this, { bufferSeconds, api, persist, onChange, notify, scheduleTimer, now, uuid });
    this.timers = new Map();
    this.running = new Set();
    this.generations = new Map();
  }
  timestamp() { return new Date(this.now()).toISOString(); }
  save() { this.persist({ version: 2, jobs: this.jobs });
    try { this.onChange(); } catch { /* A disconnected renderer must not change delivery state. */ } }
  get(id) {
    if (typeof id !== 'string' || id.length > 512) throw new Error('Invalid schedule ID.');
    const job = this.jobs.find((item) => item.id === id);
    if (!job) throw new Error('Schedule was not found.');
    return job;
  }
  present(job) {
    const status = deliveryStatus(job);
    return { ...job, deliveryStatus: status, note: status === 'unconfirmed' ? 'Delivery could not be confirmed. Check delivery before scheduling again.' : status === 'failed' ? job.error?.message || 'This delivery failed. Check connection settings and API compatibility.' : status === 'sent' ? 'Sent to T3 Code' : job.note, effectiveAt: new Date(Date.parse(job.scheduleAt) + job.bufferSeconds * 1000).toISOString(), deliveryLabel: ({pending:'Scheduled',dispatching:'Sending',sent:'Sent to T3 Code',failed:'Failed',canceled:'Canceled',unconfirmed:'Delivery unconfirmed'})[status] };
  }
  list({ view = 'all', status, offset = 0, limit = 100 } = {}) {
    if (!['all', 'upcoming', 'history'].includes(view) || (status && !['pending','dispatching','sent','failed','canceled','unconfirmed'].includes(status))) throw new Error('Invalid schedule filter.');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid pagination.');
    const filtered = this.jobs.filter((job) => (!status || deliveryStatus(job) === status) && (view === 'all' || (view === 'history' ? terminal.has(job.status) : !terminal.has(job.status))));
    filtered.sort((a,b) => view === 'upcoming' ? Date.parse(a.scheduleAt) + a.bufferSeconds*1000 - Date.parse(b.scheduleAt) - b.bufferSeconds*1000 || a.id.localeCompare(b.id) : Date.parse(b.updatedAt || b.createdAt || b.scheduleAt) - Date.parse(a.updatedAt || a.createdAt || a.scheduleAt) || a.id.localeCompare(b.id));
    return { jobs: filtered.slice(offset, offset + limit).map((job) => this.present(job)), total: filtered.length, unacknowledgedFailures: this.jobs.filter((job) => ['failed','unconfirmed'].includes(deliveryStatus(job)) && !job.acknowledgedAt).length };
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
    const [thread, snapshot] = await Promise.all([
      this.api.fetchThread(input.threadId),
      this.api.fetchSnapshot ? this.api.fetchSnapshot().catch(() => null) : null
    ]);
    if (thread.archivedAt) throw new Error('That thread is archived. Choose another thread.');
    const createdAt = this.timestamp();
    // Revalidate after the asynchronous baseline read.
    validateScheduleInput(input);
    const job = { id: this.uuid(), commandId: this.uuid(), messageId: this.uuid(), threadId: input.threadId, message: input.message, scheduleAt: input.whenISO,
      status: 'pending', deliveryCertainty: 'not-delivered', createdAt, updatedAt: this.timestamp(), activitySince: createdAt,
      baselineUserTurnAt: findLatestUserTurnAt(thread)?.toISOString() || null,
      threadTitle: thread.title || '(Untitled thread)', projectId: thread.projectId || '', projectName: snapshot?.projects?.find((project) => project?.id === thread.projectId)?.title || snapshot?.projects?.find((project) => project?.id === thread.projectId)?.name || thread.projectId || '',
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
    return { threadId: job.threadId, message: job.message, timeZone: job.timeZone };
  }
  async reconcile(id) {
    const job = this.get(id);
    if (deliveryStatus(job) !== 'unconfirmed') throw new Error('Only unconfirmed deliveries need reconciliation.');
    const thread = await this.api.fetchThread(job.threadId);
    if (hasMessageId(thread, job.messageId)) this.patch(job, { ...(job.status === 'failed' ? {} : { status: 'sent', note: 'Message confirmed in T3 Code' }), deliveryCertainty: 'delivered', confirmedAt: this.timestamp(), error: null });
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
  async run(id) {
    const job = this.get(id);
    if (job.status !== 'pending' || this.running.has(id)) return;
    if (Date.parse(job.scheduleAt) + job.bufferSeconds*1000 > this.now()) { this.schedule(job); return; }
    this.running.add(id); this.cancelTimer(id);
    let dispatched = false;
    try {
      this.patch(job, { status: 'dispatching', note: 'Checking thread before dispatch', lateBySeconds: Math.max(0, Math.floor((this.now()-Date.parse(job.scheduleAt)-job.bufferSeconds*1000)/1000)) });
      const thread = await this.api.fetchThread(job.threadId);
      if (hasMessageId(thread, job.messageId)) { this.patch(job, { status: 'sent', note: 'Message was already present in the thread' }); return; }
      if (thread.archivedAt) { this.patch(job, { status: 'canceled', note: 'Thread is archived' }); return; }
      const latest = findLatestUserTurnAt(thread)?.valueOf();
      const since = Date.parse(job.activitySince);
      const baseline = Date.parse(job.baselineUserTurnAt);
      if (latest && Number.isFinite(since) && latest > since && (!Number.isFinite(baseline) || latest > baseline)) {
        this.patch(job, { status: 'canceled', note: 'New user activity appeared after this schedule was created' }); return;
      }
      if (!thread.modelSelection || !thread.runtimeMode || !thread.interactionMode) throw new ApiError('unsupported_response_shape', 'T3 Code did not return the thread settings needed to send this message. Check API compatibility.');
      const command = buildTurnStartCommand(job, thread);
      // Persist the guard before the POST so a restart never automatically resends.
      this.patch(job, { dispatchAttemptedAt: this.timestamp() });
      dispatched = true;
      await this.api.dispatch(command);
      this.patch(job, { status: 'sent', note: 'Sent to T3 Code', dispatchedAt: this.timestamp(), error: null });
      try { this.notify('Sent to T3 Code', 'Your scheduled message was delivered.'); } catch { /* Delivery is already committed. */ }
    } catch (error) {
      const info = toErrorInfo(error);
      if (!dispatched && info.details?.status === 404) {
        this.patch(job, { status: 'canceled', note: 'Thread is no longer available', error: null }); return;
      }
      const uncertain = dispatched && (info.deliveryUncertain || info.code === 'unexpected');
      this.patch(job, { status: uncertain ? 'unconfirmed' : 'failed', note: info.message, error: info, acknowledgedAt: null });
      try { this.notify(uncertain ? 'Delivery unconfirmed' : 'Scheduled message failed', info.message); } catch { /* Outcome is already committed. */ }
    } finally { this.running.delete(id); }
  }
}
module.exports = { JobService, migrateJobs };
