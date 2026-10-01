'use strict';

// OpenCode through its documented HTTP server (`opencode serve`, or the TUI
// started with `--port`). Verified against OpenCode 1.18.34; see docs/harnesses.md.
const crypto = require('node:crypto');
const path = require('node:path');
const { conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { HarnessError, redact } = require('./errors');
const { matchUsageLimit } = require('./usage-limits');

const DEFAULT_PORT = 4096;
const MAX_PROJECTS = 40;
const MESSAGE_WINDOW = 50;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// OpenCode orders messages by ID, so keys use its ascending format:
// "msg_" + 12 hex digits of (milliseconds * 0x1000 + counter) + 14 base62 characters.
let lastTimestamp = 0, counter = 0;
function ascendingMessageId(now = Date.now(), random = crypto.randomBytes) {
  if (now !== lastTimestamp) { lastTimestamp = now; counter = 0; }
  counter++;
  const value = (BigInt(now) * 0x1000n + BigInt(counter)) & ((1n << 48n) - 1n);
  const bytes = random(14);
  let suffix = '';
  for (let index = 0; index < 14; index++) suffix += BASE62[bytes[index] % 62];
  return `msg_${value.toString(16).padStart(12, '0')}${suffix}`;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validSessionId = (id) => typeof id === 'string' && /^ses_[A-Za-z0-9]{1,64}$/.test(id);
const validMessageId = (id) => typeof id === 'string' && /^msg_[A-Za-z0-9]{1,64}$/.test(id);

function createOpenCodeHarness({ getSettings = () => ({}), env = process.env, fetchImpl = fetch, timeoutMs = 10_000, now = () => Date.now() } = {}) {
  function settings() {
    const values = getSettings('opencode') || {};
    return { port: Number.isInteger(values.port) ? values.port : DEFAULT_PORT, password: values.password || '', username: env.OPENCODE_SERVER_USERNAME || 'opencode' };
  }

  async function request(pathname, { method = 'GET', query = {}, body, expectEmpty = false } = {}) {
    const { port, password, username } = settings();
    const posting = method !== 'GET';
    const url = new URL(`http://127.0.0.1:${port}${pathname}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const details = { endpoint: pathname.replace(/ses_[A-Za-z0-9]+/g, ':session').replace(/msg_[A-Za-z0-9]+/g, ':message'), port };
    const headers = { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) };
    if (password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: controller.signal });
      details.status = response.status;
      const text = await response.text();
      if (response.status === 401 || response.status === 403) throw new HarnessError('authentication_rejected', password ? 'OpenCode rejected the server password. Check Settings.' : 'OpenCode requires a server password. Add it in Settings.', details);
      if (response.status === 404) {
        const notFound = /not found/i.test(text) ? new HarnessError('conversation_not_found', 'OpenCode could not find that session.', details) : new HarnessError('http_failure', 'OpenCode returned HTTP 404. Check that the port belongs to an OpenCode server.', details);
        throw notFound;
      }
      if (!response.ok) throw new HarnessError('http_failure', `OpenCode returned HTTP ${response.status}. Check the server and API compatibility.`, details, posting && response.status >= 500);
      if (expectEmpty) return null;
      if (/^\s*</.test(text)) throw new HarnessError('unexpected_response_format', 'OpenCode returned a webpage instead of the expected API response. Check the port in Settings.', details, posting);
      try { return JSON.parse(text); } catch {
        throw new HarnessError('unexpected_response_format', 'OpenCode returned an unreadable API response. Check API compatibility.', details, posting);
      }
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if (error.name === 'AbortError') throw new HarnessError('timeout', 'OpenCode did not respond in time. Check that the server is running.', details, posting);
      // A refused connection never reached OpenCode, so even a POST certainly did not arrive.
      const refused = error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED';
      throw new HarnessError('connection_refused', `Cannot connect to OpenCode on port ${port}. Start it with “opencode serve --port ${port}” or change the port in Settings.`, details, posting && !refused);
    } finally { clearTimeout(timer); }
  }
  const shape = (endpoint) => new HarnessError('unsupported_response_shape', 'OpenCode returned an unsupported API response. Check API compatibility.', { endpoint });

  async function getSession(id) {
    if (!validSessionId(id)) throw new HarnessError('conversation_not_found', 'OpenCode could not find that session.');
    const session = await request(`/session/${id}`);
    if (!isObject(session) || session.id !== id || !isObject(session.time)) throw shape('/session/:session');
    return session;
  }
  async function listMessages(session, limit = MESSAGE_WINDOW) {
    const messages = await request(`/session/${session.id}/message`, { query: { limit, directory: session.directory } });
    if (!Array.isArray(messages)) throw shape('/session/:session/message');
    return messages.filter((entry) => isObject(entry) && isObject(entry.info) && typeof entry.info.id === 'string');
  }
  async function statuses(session = {}) {
    const value = await request('/session/status', { query: { directory: session.directory } });
    return isObject(value) ? value : {};
  }

  async function projectsById() {
    const projects = await request('/project').catch(() => []);
    return new Map((Array.isArray(projects) ? projects : []).filter((project) => isObject(project) && typeof project.id === 'string')
      .map((project) => [project.id, project]));
  }
  function projectDirectories(projects) {
    return [...new Set([...projects.values()].map((project) => project.worktree).filter((dir) => typeof dir === 'string' && dir.length > 0))].slice(0, MAX_PROJECTS);
  }
  async function allStatuses(directories) {
    const maps = await Promise.all([statuses(), ...directories.map((directory) => statuses({ directory }))]);
    return Object.assign({}, ...maps);
  }

  // A 404 for one message is proof of absence only because the session itself exists.
  async function messageExists(session, messageId) {
    try {
      const message = await request(`/session/${session.id}/message/${messageId}`, { query: { directory: session.directory } });
      return isObject(message) && message.info?.id === messageId;
    } catch (error) {
      if (error.code === 'conversation_not_found') return false;
      throw error;
    }
  }
  // Pending permission prompts and questions block the agent until the user answers.
  async function pendingRequests(session) {
    const lists = await Promise.all(['/permission', '/question'].map((endpoint) => request(endpoint, { query: { directory: session.directory } })));
    if (!lists.every(Array.isArray)) return null;
    return lists.some((list) => list.some((item) => isObject(item) && item.sessionID === session.id));
  }
  function latestUser(messages) {
    return [...messages].reverse().find((entry) => entry.info.role === 'user')?.info || null;
  }
  function retryLimit(status) {
    if (status?.type !== 'retry') return null;
    const text = [status.message, status.action?.reason, status.action?.title, status.action?.message].filter((value) => typeof value === 'string').join(' ');
    const limit = matchUsageLimit(text, now());
    if (!limit) return null;
    return { resetsAt: limit.resetsAt || isoOrNull(status.next), message: status.action?.title || status.message || 'Usage limit reached' };
  }
  function assistantOutcome(info) {
    const error = isObject(info.error) ? info.error : null;
    if (error) {
      const data = isObject(error.data) ? error.data : {};
      const text = typeof data.message === 'string' ? data.message : '';
      const limit = (data.statusCode === 429 || matchUsageLimit(text, now())) ? { resetsAt: matchUsageLimit(text, now())?.resetsAt || null, message: redact(text).slice(0, 240) || 'Usage limit reached' } : null;
      if (error.name === 'MessageAbortedError') return { state: 'interrupted', completedAt: isoOrNull(info.time?.completed) };
      return { state: 'failed', completedAt: isoOrNull(info.time?.completed), error: { code: limit ? 'usage_limited' : 'agent_error', message: limit?.message || redact(text).slice(0, 240) || 'OpenCode reported an error.' }, usageLimit: limit };
    }
    return info.time?.completed ? { state: 'completed', completedAt: isoOrNull(info.time.completed) } : { state: 'running' };
  }

  return defineHarness({
    id: 'opencode', label: 'OpenCode', kind: 'local-api', conversationNoun: 'session',
    description: 'Sends through a running OpenCode server on 127.0.0.1 (opencode serve).',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: true,
      requiresRunningApp: true, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    },
    settings: [
      { key: 'port', type: 'port', label: 'OpenCode server port', default: DEFAULT_PORT, help: 'Start OpenCode with “opencode serve --port 4096”. Connects only to 127.0.0.1.' },
      { key: 'password', type: 'secret', label: 'OpenCode server password', env: 'OPENCODE_SERVER_PASSWORD', help: 'Only needed when the server sets OPENCODE_SERVER_PASSWORD.' }
    ],
    async checkConnection() {
      const health = await request('/global/health');
      if (!isObject(health) || health.healthy !== true) throw shape('/global/health');
      return { ok: true, version: typeof health.version === 'string' ? health.version.slice(0, 40) : undefined };
    },
    async listConversations() {
      const named = await projectsById();
      const directories = projectDirectories(named);
      const [status, ...lists] = await Promise.all([allStatuses(directories).catch(() => ({})), request('/session', { query: { roots: true } }),
        ...directories.map((directory) => request('/session', { query: { directory, roots: true } }).catch(() => []))]);
      const sessions = new Map();
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const session of list) {
          if (!isObject(session) || !validSessionId(session.id) || session.parentID || !isObject(session.time) || session.time.archived) continue;
          const project = named.get(session.projectID);
          const projectName = project?.name || (project?.worktree && project.worktree !== '/' ? path.basename(project.worktree) : '') || (typeof session.directory === 'string' ? path.basename(session.directory) : '');
          const current = status[session.id]?.type;
          sessions.set(session.id, conversation('opencode', {
            id: session.id, title: session.title, projectId: session.projectID, projectName,
            updatedAt: session.time.updated, settled: false, state: current === 'busy' ? 'working' : current === 'retry' ? 'retrying' : 'idle'
          }));
        }
      }
      return [...sessions.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },
    async inspectConversation(ref) {
      const session = await getSession(ref.conversationId);
      const [messages, status] = await Promise.all([listMessages(session), statuses(session).catch(() => ({}))]);
      const user = latestUser(messages);
      let delivered = false;
      if (validMessageId(ref.deliveryKey)) delivered = messages.some((entry) => entry.info.id === ref.deliveryKey) || await messageExists(session, ref.deliveryKey);
      const [project, blocked] = await Promise.all([
        request('/project/current', { query: { directory: session.directory } }).catch(() => null),
        pendingRequests(session).catch(() => null)
      ]);
      return conversationState({
        id: session.id, title: session.title, projectId: session.projectID,
        projectName: project?.name || (project?.worktree && project.worktree !== '/' ? path.basename(project.worktree) : path.basename(session.directory || '')),
        archived: Boolean(session.time.archived), latestUserActivityAt: user?.time?.created ?? null, delivered,
        busy: ['busy', 'retry'].includes(status[session.id]?.type), awaitingInput: blocked, context: { directory: session.directory, user }
      });
    },
    prepareTurn(turn, state) {
      const user = state.context?.user;
      const body = { messageID: ascendingMessageId(now()), parts: [{ type: 'text', text: turn.message }] };
      // Continue with the agent and model the user last chose in this session.
      if (typeof user?.agent === 'string' && user.agent) body.agent = user.agent;
      if (isObject(user?.model) && typeof user.model.providerID === 'string' && typeof user.model.modelID === 'string') {
        body.model = { providerID: user.model.providerID, modelID: user.model.modelID };
        if (typeof user.model.variant === 'string' && user.model.variant) body.variant = user.model.variant;
      }
      return { deliveryKey: body.messageID, plan: { directory: state.context?.directory, body } };
    },
    async submitTurn(turn, plan) {
      if (!validSessionId(turn.conversationId)) throw new HarnessError('conversation_not_found', 'OpenCode could not find that session.');
      await request(`/session/${turn.conversationId}/prompt_async`, { method: 'POST', query: { directory: plan.directory }, body: plan.body, expectEmpty: true });
      return { turnId: plan.body.messageID };
    },
    async findDelivery(turn) {
      if (!validSessionId(turn.conversationId) || !validMessageId(turn.deliveryKey)) return { delivered: false };
      return { delivered: await messageExists(await getSession(turn.conversationId), turn.deliveryKey) };
    },
    async checkTurn(turn) {
      const session = await getSession(turn.conversationId);
      const status = (await statuses(session))[session.id];
      if (status?.type === 'busy' || status?.type === 'retry') return { state: 'running', turnId: turn.deliveryKey, usageLimit: retryLimit(status) };
      const replies = (await listMessages(session)).filter((entry) => entry.info.role === 'assistant' && entry.info.parentID === turn.deliveryKey);
      if (!replies.length) return { state: 'unknown', turnId: turn.deliveryKey };
      return { turnId: turn.deliveryKey, ...assistantOutcome(replies.at(-1).info) };
    },
    async probeAvailability() {
      const status = await allStatuses(projectDirectories(await projectsById()));
      const limits = Object.values(status).map(retryLimit).filter(Boolean);
      if (!limits.length) return { state: 'unknown', reason: 'OpenCode does not report account quotas; no session is waiting on a usage limit.', source: 'none', checkedAt: new Date(now()).toISOString() };
      const resetsAt = limits.map((limit) => limit.resetsAt).filter(Boolean).sort().at(-1) || null;
      return { state: 'limited', resetsAt, reason: limits[0].message, source: 'inferred', checkedAt: new Date(now()).toISOString() };
    }
  });
}

module.exports = { DEFAULT_PORT, ascendingMessageId, createOpenCodeHarness };
