'use strict';

const z = require('zod/v4');
const { RemoteError, toRemoteError } = require('./errors');
const { IdempotencyStore } = require('./idempotency');

const DEFAULT_MESSAGE = 'Continue';
const MAX_DELAY_MINUTES = 525_600;

// Schemas describe shapes for remote clients and MCP tool discovery.
// Domain rules (dates, message length, filters, state transitions) stay in the
// job service so the remote path and the desktop UI can never disagree.
// Only remote-only fields get length limits here; the rest are checked by the job service.
const text = (description, max) => (max ? z.string().max(max) : z.string()).describe(description);
const harnessField = text('Harness ID from list_harnesses, for example t3. Defaults to the primary harness.', 64).optional();
const jobId = text('Schedule ID, as returned by list_jobs or schedule_message.');
const when = {
  whenISO: text('Requested send time as an ISO 8601 date-time with an explicit offset, for example 2026-10-01T09:00:00+01:00. Provide this or delayMinutes.').optional(),
  delayMinutes: z.number().int().min(1).max(MAX_DELAY_MINUTES).describe('Minutes from now. Provide this or whenISO.').optional(),
  timeZone: text('IANA timezone used to display the schedule, for example Europe/London. Defaults to the Mac timezone.').optional()
};
const byId = z.object({ id: jobId }).strict();
const byHarness = z.object({ harness: harnessField }).strict();

const schemas = {
  status: z.object({}).strict(),
  listHarnesses: z.object({}).strict(),
  checkConnection: byHarness,
  getAvailability: byHarness,
  listThreads: z.object({
    harness: harnessField,
    projectId: text('Only include threads from this project.', 512).optional(),
    query: text('Case-insensitive text matched against thread titles and project names.', 200).optional(),
    showSettled: z.boolean().describe('Include threads the harness marks as settled. Defaults to false.').optional(),
    limit: z.number().int().min(1).max(500).describe('Maximum threads to return. Defaults to 100.').optional()
  }).strict(),
  listProjects: byHarness,
  listJobs: z.object({
    view: text('upcoming (pending or sending, soonest first), history (finished, newest first) or all. Defaults to all.').optional(),
    status: text('Only include one delivery status: pending, dispatching, sent, failed, canceled or unconfirmed.').optional(),
    offset: z.number().int().describe('Records to skip. Defaults to 0.').optional(),
    limit: z.number().int().describe('Records to return, 1 to 500. Defaults to 100.').optional()
  }).strict(),
  getJob: byId,
  createJob: z.object({
    threadId: text('Thread (conversation) ID from list_threads.'),
    message: text('Message to send. Defaults to "Continue". 1 to 4000 characters.').optional(),
    ...when,
    harness: harnessField,
    idempotencyKey: text('Optional client-generated key. Retrying with the same key returns the original schedule instead of creating a duplicate.').optional()
  }).strict(),
  editJob: z.object({ id: jobId, message: text('Replacement message, 1 to 4000 characters.').optional(), ...when }).strict(),
  cancelJob: byId,
  acknowledgeJob: byId,
  reconcileJob: byId,
  listRuns: z.object({}).strict(),
  stopRun: z.object({ id: text('Continuous run ID from list_runs.', 512) }).strict()
};

function describeIssues(error) {
  const issue = error.issues[0];
  const field = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue?.message || 'Invalid request.'}`;
}

/**
 * Transport-neutral scheduler operations shared by the HTTP API and the MCP server.
 * @param {object} deps
 * @param {() => import('../job-service').JobService} deps.getService
 * @param {() => void} deps.ensureStorage Throws while local storage is unavailable.
 * @param {() => ({code: string, message: string}|null|undefined)} deps.getStorageError
 * @param {{defaultHarness: string, describe: () => object[], has: (id: string) => boolean, get: (id: string) => object}} deps.harnesses
 *   Harness registry: see lib/remote/harnesses.js and docs/remote-control.md.
 * @param {{status: () => object}} [deps.keepAwake] Optional read-only keep-awake provider.
 * @param {{listRuns: () => Promise<object[]>, stopRun: (id: string) => Promise<object>}} [deps.automation] Optional continuous-run provider.
 * @param {{name: string, version: string}} deps.appInfo
 * @param {IdempotencyStore} deps.idempotency
 * @param {import('./audit').AuditLog} deps.audit
 */
function createOperations(deps) {
  const now = deps.now || (() => Date.now());
  const registry = deps.harnesses;
  const service = () => deps.getService();
  const writable = () => {
    try { deps.ensureStorage(); } catch (error) { throw new RemoteError(503, 'storage_unavailable', error.message); }
  };
  const present = (job) => ({ harness: registry.defaultHarness, ...service().present(job) });
  const resolveHarness = (id) => {
    if (id === undefined) return registry.defaultHarness;
    if (!registry.has(id)) throw new RemoteError(400, 'unknown_harness', `Unknown harness "${id}". Available: ${registry.describe().map((item) => item.id).join(', ')}.`);
    return id;
  };
  const resolveWhen = (input, fallback) => {
    if (input.whenISO !== undefined && input.delayMinutes !== undefined) throw new RemoteError(400, 'validation_failed', 'Provide either whenISO or delayMinutes, not both.');
    if (input.delayMinutes !== undefined) return new Date(now() + input.delayMinutes * 60_000).toISOString();
    return input.whenISO ?? fallback;
  };
  const connection = async (id) => {
    try { await registry.get(id).checkConnection(); return { harness: id, online: true }; } catch (error) {
      const failure = toRemoteError(error);
      return { harness: id, online: false, error: { code: failure.details?.upstream?.code || failure.code, message: failure.message } };
    }
  };
  const automation = () => {
    if (!deps.automation) throw new RemoteError(501, 'not_supported', 'Continuous runs are not available in this version of the desktop app.');
    return deps.automation;
  };

  const operations = {
    status: {
      mutating: false,
      async run(_input, context) {
        const storageError = deps.getStorageError() || null;
        const harnesses = await Promise.all(registry.describe().map(async (item) => {
          const { harness: _id, ...state } = await connection(item.id);
          return { id: item.id, label: item.label, conversationNoun: item.conversationNoun, ...state };
        }));
        const counts = service().list({ view: 'upcoming', limit: 1 });
        let keepAwake = null;
        if (deps.keepAwake) {
          try { keepAwake = await deps.keepAwake.status(); } catch { keepAwake = { available: false, error: 'Keep-awake status is unavailable.' }; }
        }
        return {
          desktop: { app: deps.appInfo.name, version: deps.appInfo.version, time: new Date(now()).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          storage: { ok: !storageError, ...(storageError ? { error: storageError } : {}) },
          defaultHarness: registry.defaultHarness, harnesses,
          jobs: { upcoming: counts.total, unacknowledgedFailures: counts.unacknowledgedFailures },
          capabilities: { keepAwake: Boolean(deps.keepAwake), continuousRuns: Boolean(deps.automation) },
          keepAwake, caller: { label: context.token.label, scope: context.token.scope }
        };
      }
    },
    listHarnesses: {
      mutating: false,
      // Setting descriptors stay desktop-only; remote clients only need identity and capabilities.
      async run() { return { harnesses: registry.describe().map(({ settings: _settings, ...item }) => item), defaultHarness: registry.defaultHarness }; }
    },
    checkConnection: {
      mutating: false,
      async run(input) { return connection(resolveHarness(input.harness)); }
    },
    getAvailability: {
      mutating: false,
      async run(input) {
        const id = resolveHarness(input.harness);
        const adapter = registry.get(id);
        const availability = typeof adapter.probeAvailability === 'function' ? await adapter.probeAvailability() :
          { state: 'unknown', resetsAt: null, reason: 'This harness does not report usage limits.', source: 'none', checkedAt: new Date(now()).toISOString() };
        return { harness: id, availability };
      }
    },
    listThreads: {
      mutating: false,
      async run(input) {
        const id = resolveHarness(input.harness);
        const query = input.query?.trim().toLocaleLowerCase();
        const threads = (await registry.get(id).listConversations({ showSettled: input.showSettled === true }))
          .filter((thread) => (input.projectId === undefined || thread.projectId === input.projectId) &&
            (!query || `${thread.title} ${thread.projectName || ''}`.toLocaleLowerCase().includes(query)))
          .map((thread) => ({ harness: id, ...thread }));
        return { threads: threads.slice(0, input.limit ?? 100), total: threads.length };
      }
    },
    listProjects: {
      mutating: false,
      // Projects are derived from conversations so every harness adapter supports them.
      async run(input) {
        const id = resolveHarness(input.harness);
        const projects = new Map();
        for (const thread of await registry.get(id).listConversations({ showSettled: true })) {
          if (!thread.projectId) continue;
          const project = projects.get(thread.projectId) || { harness: id, id: thread.projectId, name: thread.projectName || thread.projectId, threads: 0 };
          project.threads += 1;
          projects.set(thread.projectId, project);
        }
        return { projects: [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
      }
    },
    listJobs: {
      mutating: false,
      async run(input) {
        const options = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
        const result = service().list(options);
        return { ...result, jobs: result.jobs.map((job) => ({ harness: registry.defaultHarness, ...job })) };
      }
    },
    getJob: {
      mutating: false,
      async run(input) { return { job: present(service().get(input.id)) }; }
    },
    createJob: {
      mutating: true,
      target: (input, result) => result?.job?.id || input.threadId,
      async run(input, context) {
        writable();
        const harness = resolveHarness(input.harness);
        const key = IdempotencyStore.validateKey(input.idempotencyKey);
        const request = {
          threadId: input.threadId, message: input.message ?? DEFAULT_MESSAGE, whenISO: resolveWhen(input), timeZone: input.timeZone,
          ...(input.harness !== undefined ? { harness } : {})
        };
        // Fingerprint the caller's request, not the resolved time, so a retried delayMinutes request matches.
        const outcome = await deps.idempotency.run({ tokenId: context.token.id, key, request: { ...input, idempotencyKey: undefined }, create: () => service().create(request) });
        return { job: present(service().get(outcome.replayed ? outcome.jobId : outcome.result.id)), replayed: outcome.replayed };
      }
    },
    editJob: {
      mutating: true,
      target: (input) => input.id,
      async run(input) {
        writable();
        const job = service().get(input.id);
        if (input.message === undefined && input.whenISO === undefined && input.delayMinutes === undefined && input.timeZone === undefined) {
          throw new RemoteError(400, 'validation_failed', 'Provide at least one of message, whenISO, delayMinutes or timeZone.');
        }
        // The desktop editor always submits the full schedule; fill omitted fields from the saved job the same way.
        return { job: present(service().edit(job.id, { message: input.message ?? job.message, whenISO: resolveWhen(input, job.scheduleAt), timeZone: input.timeZone ?? job.timeZone ?? undefined })) };
      }
    },
    cancelJob: {
      mutating: true,
      target: (input) => input.id,
      async run(input) { writable(); return { job: present(service().cancel(input.id)) }; }
    },
    acknowledgeJob: {
      mutating: true,
      target: (input) => input.id,
      async run(input) { writable(); return { job: present(service().acknowledge(input.id)) }; }
    },
    reconcileJob: {
      mutating: true,
      target: (input) => input.id,
      async run(input) {
        writable();
        service().get(input.id);
        try { return { job: present(await service().reconcile(input.id)) }; } catch (error) {
          // The job exists, so a plain validation error here can only be its delivery state.
          if (Object.getPrototypeOf(error) === Error.prototype && !error.code) throw new RemoteError(409, 'invalid_state', error.message);
          throw error;
        }
      }
    },
    listRuns: {
      mutating: false,
      async run() { return { runs: await automation().listRuns() }; }
    },
    stopRun: {
      mutating: true,
      target: (input) => input.id,
      // Stopping must work even when schedule storage is degraded; the provider owns its own state.
      async run(input) { return { run: await automation().stopRun(input.id) }; }
    }
  };

  /**
   * Validates, authorises, runs and audits one operation.
   * @param {string} name
   * @param {unknown} input
   * @param {{token: {id: string, label: string, scope: string}, transport: string, remoteAddress?: string}} context
   */
  async function run(name, input, context) {
    const operation = operations[name];
    if (!operation) throw new RemoteError(404, 'unknown_operation', 'That operation does not exist.');
    const audit = (outcome, detail = {}) => operation.mutating && deps.audit.record({
      action: name, outcome, tokenId: context.token.id, tokenLabel: context.token.label, transport: context.transport,
      remoteAddress: context.remoteAddress, ...detail
    });
    try {
      if (operation.mutating && context.token.scope !== 'control') throw new RemoteError(403, 'insufficient_scope', 'This device token is read only.');
      const parsed = schemas[name].safeParse(input ?? {});
      if (!parsed.success) throw new RemoteError(400, 'validation_failed', describeIssues(parsed.error));
      const result = await operation.run(parsed.data, context);
      // A replayed idempotent request changed nothing, and the log says so.
      audit(result?.replayed ? 'replayed' : 'ok', { target: operation.target?.(parsed.data, result) });
      return result;
    } catch (error) {
      const failure = toRemoteError(error);
      const target = input && typeof input === 'object' ? operation.target?.(input) : undefined;
      audit(failure.code === 'insufficient_scope' ? 'denied' : 'error', { target: typeof target === 'string' ? target : undefined, error: `${failure.code}: ${failure.message}` });
      throw failure;
    }
  }

  // Continuous-run operations only exist when a provider is wired in.
  const available = (name) => !['listRuns', 'stopRun'].includes(name) || Boolean(deps.automation);
  return { run, operations, schemas, available };
}

module.exports = { createOperations, schemas, DEFAULT_MESSAGE };
