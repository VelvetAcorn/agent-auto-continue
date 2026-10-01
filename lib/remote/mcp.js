'use strict';

const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { RemoteError } = require('./errors');

const INSTRUCTIONS = [
  'Controls Agent Auto-Continue, a Mac app that sends a scheduled message (usually "Continue") to an agent thread at a chosen time.',
  'The Mac is the source of truth; every tool reads or changes its live schedule.',
  'Use list_threads to find a thread ID, then schedule_message. Pass an idempotencyKey so a retried call cannot create a duplicate.',
  'schedule_message can also start an automatic continuation (trigger, turnLimit, continuous) when list_harnesses reports automation support; stop it with stop_run or stop_all_runs.',
  '"sent" means the harness accepted the message, not that the agent finished its work.',
  '"unconfirmed" means delivery is uncertain; use reconcile_job to check it and never schedule the same message again until it is confirmed.'
].join('\n');

// Tool name, operation, description and MCP behaviour hints.
const TOOLS = [
  ['get_status', 'status', 'Show whether the Mac and each agent harness are reachable, storage health, queue counts and optional keep-awake status.', { readOnlyHint: true, openWorldHint: false }],
  ['list_harnesses', 'listHarnesses', 'List the agent harnesses this Mac can schedule for, with their capabilities.', { readOnlyHint: true, openWorldHint: false }],
  ['check_connection', 'checkConnection', 'Check whether one agent harness is reachable right now.', { readOnlyHint: true, openWorldHint: false }],
  ['get_availability', 'getAvailability', 'Report whether a harness is currently usage limited and when the limit resets, when the harness reports it.', { readOnlyHint: true, openWorldHint: false }],
  ['list_threads', 'listThreads', 'List agent threads that can receive a scheduled message, most recently active first. Archived threads are never listed.', { readOnlyHint: true, openWorldHint: false }],
  ['list_projects', 'listProjects', 'List projects known to an agent harness.', { readOnlyHint: true, openWorldHint: false }],
  ['list_jobs', 'listJobs', 'List scheduled messages and their delivery history with optional view and status filters.', { readOnlyHint: true, openWorldHint: false }],
  ['get_job', 'getJob', 'Get one scheduled message with its full delivery details.', { readOnlyHint: true, openWorldHint: false }],
  ['schedule_message', 'createJob', 'Schedule a message (default "Continue") to be sent to a thread at a future time.', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }],
  ['edit_job', 'editJob', 'Change the message or time of a scheduled message that has not started sending.', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }],
  ['cancel_job', 'cancelJob', 'Cancel a scheduled message that has not started sending. The record stays in history.', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ['acknowledge_job', 'acknowledgeJob', 'Acknowledge a failed or unconfirmed delivery to clear its attention badge. Never resends anything.', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['reconcile_job', 'reconcileJob', 'Check whether an unconfirmed delivery reached the thread. Reads the thread only and never resends.', { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
  ['list_runs', 'listRuns', 'List automatic continuations that are running or paused, with their turn progress and any pause reason.', { readOnlyHint: true, openWorldHint: false }],
  ['stop_run', 'stopRun', 'Stop an automatic continuation so no further turns are sent. A turn already running keeps running in the agent.', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
  ['stop_all_runs', 'stopAllRuns', 'Stop every running or paused automatic continuation at once. Plain scheduled messages are left alone.', { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }],
  ['resume_run', 'resumeRun', 'Resume a paused automatic continuation from where it stopped. Never resends; refused while a delivery is unconfirmed.', { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }]
];

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function toolError(error) {
  const body = { error: { code: error.code, message: error.message } };
  return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }], structuredContent: body };
}

/**
 * Builds the MCP request handler. A fresh McpServer is created per request (stateless),
 * exposing only the tools the caller's token scope permits.
 * @param {{operations: ReturnType<typeof import('./operations').createOperations>, appInfo: {name: string, version: string}}} options
 */
function createMcpEndpoint({ operations, appInfo, maxRequestBodySize }) {
  const handler = createMcpHandler(({ authInfo }) => {
    const context = authInfo?.extra?.context;
    const server = new McpServer({ name: 'agent-auto-continue', title: appInfo.name, version: appInfo.version }, { instructions: INSTRUCTIONS });
    for (const [name, operation, description, annotations] of TOOLS) {
      if (!context || !operations.available(operation) || (operations.operations[operation].mutating && context.token.scope !== 'control')) continue;
      server.registerTool(name, { description, inputSchema: operations.schemas[operation], annotations }, async (input) => {
        try { return toolResult(await operations.run(operation, input, context)); } catch (error) {
          return toolError(error instanceof RemoteError ? error : new RemoteError(500, 'internal_error', 'The desktop app could not complete the request.'));
        }
      });
    }
    return server;
  }, { maxRequestBodySize });
  return {
    /** @param {Request} request @param {object} context Authenticated caller context. */
    fetch: (request, context) => handler.fetch(request, { authInfo: { token: 'redacted', clientId: context.token.id, scopes: [context.token.scope], extra: { context } } }),
    close: () => handler.close()
  };
}

module.exports = { createMcpEndpoint, TOOLS, INSTRUCTIONS };
