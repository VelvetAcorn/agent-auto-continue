'use strict';

// Reports T3 Code work that needs the Mac awake: scheduled jobs waiting to send,
// deliveries in flight, and the agent turn a delivery started (tracked through the
// thread session in the orchestration snapshot). Other harnesses provide their own source.

const MINUTE = 60_000;
const WORKING_SESSION_STATES = new Set(['starting', 'running']);

// T3 Code 0.0.40 threads expose `session: { status, activeTurnId } | null`.
// A null session, or a session that is idle/ready/stopped/interrupted/error without an
// active turn, is not working.
function threadIsWorking(thread) {
  const session = thread?.session;
  if (!session || typeof session !== 'object') return false;
  return WORKING_SESSION_STATES.has(session.status) || (typeof session.activeTurnId === 'string' && session.activeTurnId.length > 0);
}

function createT3WorkSource({ service, api, now = () => Date.now(), getOptions = () => ({}), startGraceMs = 3 * MINUTE, unknownWindowMs = 30 * MINUTE, freshMs = 150_000 }) {
  const listeners = new Set();
  const closed = new Set();
  const lastWorkingAt = new Map();
  let snapshot = null;
  let answering = false;

  function options() {
    const value = getOptions() || {};
    return { includeRunningAgents: value.includeRunningAgents === true, horizonMs: Number.isFinite(value.horizonMs) && value.horizonMs > 0 ? value.horizonMs : 12 * 60 * MINUTE };
  }
  // Jobs without a harness predate multi-harness support and belong to T3 Code.
  function jobs() { return (Array.isArray(service?.jobs) ? service.jobs : []).filter((job) => !job.harness || job.harness === 't3'); }
  // Only a recorded dispatch attempt starts an agent turn. Legacy records, and messages found
  // already present in the thread, have no attempt time and are not watched.
  function sentAt(job) {
    for (const value of [job.dispatchedAt, job.dispatchAttemptedAt]) {
      const time = Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
    return null;
  }
  // Delivered, or possibly delivered: the agent may be working on it.
  function mayHaveStartedTurn(job) {
    if (job.status === 'sent') return job.deliveryCertainty !== 'not-delivered';
    return job.deliveryCertainty === 'unknown' && ['unconfirmed', 'failed'].includes(job.status) && Boolean(job.dispatchAttemptedAt);
  }
  function watchedJobs() {
    const { horizonMs } = options();
    const time = now();
    return jobs().filter((job) => mayHaveStartedTurn(job) && !closed.has(job.id) && sentAt(job) !== null && time - sentAt(job) <= horizonMs);
  }
  function fresh() { return Boolean(snapshot && now() - snapshot.at <= freshMs); }
  function needsSnapshot() {
    return options().includeRunningAgents || watchedJobs().length > 0 || jobs().some((job) => job.status === 'dispatching');
  }

  function jobTask(job, state, detail, until = null) {
    // `job:<id>` matches the activeWork() source, so the registry de-duplicates the two.
    return { id: `job:${job.id}`, harness: 't3', conversation: `t3:${job.threadId}`, label: job.threadTitle || job.threadId, state, detail, until };
  }

  function tasks() {
    const time = now();
    const out = [];
    for (const job of jobs()) {
      if (job.status === 'pending') {
        const effective = Date.parse(job.scheduleAt) + (Number(job.bufferSeconds) || 0) * 1000;
        out.push(jobTask(job, 'waiting', 'Scheduled message waiting to send', Number.isFinite(effective) ? new Date(effective).toISOString() : null));
      } else if (job.status === 'dispatching') {
        out.push(jobTask(job, 'running', 'Sending scheduled message'));
      }
    }
    for (const job of watchedJobs()) {
      const started = sentAt(job);
      const thread = fresh() ? snapshot.threads.get(job.threadId) : undefined;
      const uncertain = job.status !== 'sent';
      if (thread && threadIsWorking(thread)) {
        out.push(jobTask(job, 'running', uncertain ? 'Delivery unconfirmed, but the agent is working' : 'Agent is working on your message'));
      } else if (time - started <= startGraceMs) {
        out.push(jobTask(job, 'running', 'Waiting for the agent to start', new Date(started + startGraceMs).toISOString()));
      } else if (fresh() && snapshot.at >= started + startGraceMs) {
        // Observed idle (or the thread is gone) after the start grace: the turn is over.
        // An idle reading from inside the grace proves nothing, because the turn may start later.
        closed.add(job.id);
        continue;
      } else if (fresh() && answering) {
        // T3 Code is answering, but its last reading predates the grace; the next poll settles it.
        out.push(jobTask(job, 'running', 'Checking whether the agent has finished'));
      } else {
        const seen = Math.max(started, lastWorkingAt.get(job.threadId) || 0);
        if (time - seen > unknownWindowMs) { closed.add(job.id); continue; }
        out.push(jobTask(job, 'unknown', 'T3 Code is not responding, so completion cannot be confirmed', new Date(seen + unknownWindowMs).toISOString()));
      }
    }
    if (options().includeRunningAgents) {
      if (fresh()) {
        for (const thread of snapshot.threads.values()) {
          if (thread.archivedAt || !threadIsWorking(thread)) continue;
          out.push({ id: `t3:thread:${thread.id}`, harness: 't3', conversation: `t3:${thread.id}`, supplementary: true, label: thread.title || '(Untitled thread)', state: 'running', detail: 'Agent turn running in T3 Code', until: null });
        }
      } else {
        for (const [threadId, seenAt] of lastWorkingAt) {
          if (time - seenAt > unknownWindowMs) continue;
          const title = snapshot?.threads.get(threadId)?.title || '(Untitled thread)';
          out.push({ id: `t3:thread:${threadId}`, harness: 't3', conversation: `t3:${threadId}`, supplementary: true, label: title, state: 'unknown', detail: 'T3 Code is not responding, so completion cannot be confirmed', until: new Date(seenAt + unknownWindowMs).toISOString() });
        }
      }
    }
    return out;
  }

  async function refresh() {
    if (!needsSnapshot()) return;
    try {
      const result = await api.fetchSnapshot();
      const threads = new Map((Array.isArray(result?.threads) ? result.threads : []).filter((thread) => thread && typeof thread.id === 'string').map((thread) => [thread.id, thread]));
      const at = now();
      const working = (thread) => Boolean(thread && !thread.archivedAt && threadIsWorking(thread));
      for (const thread of threads.values()) if (working(thread)) lastWorkingAt.set(thread.id, at);
      for (const id of lastWorkingAt.keys()) if (!working(threads.get(id))) lastWorkingAt.delete(id);
      snapshot = { at, threads };
      answering = true;
    } catch {
      answering = false;
      // Leave the previous snapshot to go stale; tasks() then reports completion as unknown.
    }
    changed();
  }

  function changed() {
    for (const listener of listeners) {
      try { listener(); } catch { /* Listener failures must not stop other listeners. */ }
    }
  }

  return {
    id: 't3', label: 'T3 Code', tasks, refresh, changed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

module.exports = { createT3WorkSource, threadIsWorking };
