'use strict';

// Adapts the job service's harness-neutral `activeWork()` view (issue #2 contract) into a
// keep-awake work source. Items are `{ jobId, harness, conversationId, phase, effectiveAt,
// requiresUnlockedScreen }` with phase `scheduled`, `sending` or `running`.
// Task IDs use `job:<id>`, matching the T3 Code source, so the registry reports each job once.

const PHASES = { scheduled: 'waiting', sending: 'running', running: 'running' };
const DETAILS = { scheduled: 'Scheduled message waiting to send', sending: 'Sending scheduled message', running: 'Agent is working on your message' };

function createActiveWorkSource({ service, id = 'active-work', label = 'Scheduled work' }) {
  if (!service || typeof service.activeWork !== 'function') throw new Error('The job service does not provide activeWork().');
  const listeners = new Set();
  function title(work) {
    const job = Array.isArray(service.jobs) ? service.jobs.find((item) => item.id === work.jobId) : null;
    return job?.threadTitle || job?.conversationTitle || work.conversationId || work.jobId;
  }
  return {
    id, label,
    tasks() {
      return service.activeWork().filter((work) => work && typeof work.jobId === 'string' && PHASES[work.phase]).map((work) => ({
        id: `job:${work.jobId}`, harness: work.harness || 't3', conversation: `${work.harness || 't3'}:${work.conversationId}`,
        label: title(work), state: PHASES[work.phase], detail: DETAILS[work.phase],
        until: work.phase === 'scheduled' && typeof work.effectiveAt === 'string' ? work.effectiveAt : null,
        requiresUnlockedScreen: work.requiresUnlockedScreen === true
      }));
    },
    changed() { for (const listener of listeners) { try { listener(); } catch { /* Keep notifying others. */ } } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

module.exports = { createActiveWorkSource };
