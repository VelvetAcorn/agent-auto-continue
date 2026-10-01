'use strict';

const { RemoteError } = require('./errors');

// A run is an automatic continuation (issue #3): a schedule with a chain. Plain schedules are
// managed through the job resources instead.
const LIVE = new Set(['active', 'paused']);

/** The remote view of one continuation, from the job service's presented job. */
function toRun(job) {
  const auto = job.automation;
  return {
    id: job.id, harness: job.harness, harnessLabel: job.harnessLabel, threadId: job.threadId, threadTitle: job.threadTitle || null, message: job.message,
    state: auto.state, status: job.displayStatus, deliveryStatus: job.deliveryStatus, trigger: auto.trigger,
    turnLimit: auto.unlimited ? null : auto.limit, continuous: auto.unlimited, turnsSent: auto.sentTurns, currentTurn: auto.currentTurn,
    remainingTurns: auto.remainingTurns, progress: auto.progressLabel, reasonCode: auto.reasonCode || null, reason: auto.reason || '',
    nextCheckAt: job.waiting?.nextCheckAt || null, canStop: job.canStop, canResume: job.canResume
  };
}

/**
 * Continuous-run provider for the remote API, backed by the job service's stop, stopAll and
 * resumeChain, which are the same entry points as the desktop UI and the tray.
 * @param {{getService: () => import('../job-service').JobService, ensureStorage: () => void}} deps
 */
function createContinuationRuns({ getService, ensureStorage }) {
  const service = () => getService();
  // Stop and resume persist the chain, so they need writable storage like every other change.
  const writable = () => {
    try { ensureStorage(); } catch (error) { throw new RemoteError(503, 'storage_unavailable', error.message); }
  };
  const chainJob = (id) => {
    const job = service().get(id);
    if (!job.chain) throw new RemoteError(404, 'run_not_found', 'That schedule is not an automatic continuation. Use the job resources to cancel it.');
    return job;
  };
  const present = (id) => toRun(service().present(service().get(id)));
  return {
    async listRuns() {
      return service().jobs.filter((job) => job.chain && LIVE.has(job.chain.state)).map((job) => toRun(service().present(job)));
    },
    async stopRun(id) {
      writable();
      chainJob(id);
      service().stop(id);
      return present(id);
    },
    async stopAll() {
      writable();
      const { stopped } = service().stopAll();
      return stopped.map(present);
    },
    async resumeRun(id) {
      writable();
      chainJob(id);
      service().resumeChain(id);
      return present(id);
    }
  };
}

module.exports = { createContinuationRuns, toRun };
