'use strict';

// Adapts the job service's harness-neutral `activeWork()` view (issue #2 contract, extended by
// the continuations of issue #3) into a keep-awake work source. Items are `{ jobId, harness,
// conversationId, phase, effectiveAt, nextCheckAt, requiresUnlockedScreen, chain }` with phase
// `scheduled`, `waiting`, `sending` or `running`. `activeWork()` already includes every active
// chain, including the gap between turns, and excludes paused chains, which wait for the user.
// Task IDs use `job:<id>`, matching the T3 Code source, so the registry reports each job once;
// main.js registers this source first, so its chain-aware view wins for every job it reports.

const PHASES = { scheduled: 'waiting', waiting: 'waiting', sending: 'running', running: 'running' };
const DETAILS = {
  scheduled: 'Scheduled message waiting to send',
  sending: 'Sending scheduled message',
  running: 'Agent is working on your message'
};
// Why a pending turn is held back, from the job's latest availability reading and wait reason.
function waitingDetail(job) {
  const reason = job?.availability?.reason;
  if (reason === 'screen_locked') return 'Waiting for the Mac to be unlocked';
  if (reason === 'conversation_busy') return 'Waiting for the agent to finish its current turn';
  if (job?.availability?.state === 'limited' || job?.waitReason === 'limit-reset') return 'Waiting for the usage limit to reset';
  if (job?.waitReason === 'continuation') return 'Waiting to send the next turn';
  return 'Waiting for the agent to be available';
}
function progress(chain) {
  if (!chain || typeof chain !== 'object' || !Number.isSafeInteger(chain.currentTurn)) return '';
  return chain.unlimited ? ` · turn ${chain.currentTurn}, continuous` : chain.limit > 1 ? ` · turn ${Math.min(chain.currentTurn, chain.limit)} of ${chain.limit}` : '';
}
const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);

function createActiveWorkSource({ service, id = 'active-work', label = 'Scheduled work' }) {
  if (!service || typeof service.activeWork !== 'function') throw new Error('The job service does not provide activeWork().');
  const listeners = new Set();
  const jobFor = (work) => (Array.isArray(service.jobs) ? service.jobs.find((item) => item.id === work.jobId) : null);
  return {
    id, label,
    tasks() {
      return service.activeWork().filter((work) => work && typeof work.jobId === 'string' && PHASES[work.phase]).map((work) => {
        const job = jobFor(work);
        const harness = work.harness || 't3';
        // A waiting turn is next looked at by its check time; a scheduled one by its send time.
        const until = work.phase === 'waiting' ? iso(work.nextCheckAt) || iso(work.effectiveAt) : work.phase === 'scheduled' ? iso(work.effectiveAt) : null;
        return {
          id: `job:${work.jobId}`, harness, conversation: `${harness}:${work.conversationId}`,
          label: job?.threadTitle || job?.conversationTitle || work.conversationId || work.jobId,
          state: PHASES[work.phase], detail: (work.phase === 'waiting' ? waitingDetail(job) : DETAILS[work.phase]) + progress(work.chain),
          until, requiresUnlockedScreen: work.requiresUnlockedScreen === true
        };
      });
    },
    changed() { for (const listener of listeners) { try { listener(); } catch { /* Keep notifying others. */ } } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

module.exports = { createActiveWorkSource };
