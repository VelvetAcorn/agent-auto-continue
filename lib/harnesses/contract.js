'use strict';

// Harness adapter contract, version 1. docs/harnesses.md is the narrative reference.
// Adapters are plain objects validated by defineHarness(); construction must be
// side-effect free (no processes, sockets or file reads until a method is called).

const CONTRACT_VERSION = 1;
const HARNESS_ID = /^[a-z][a-z0-9-]{0,31}$/;
const KINDS = new Set(['local-api', 'cli', 'desktop-app']);
const NOUNS = new Set(['thread', 'session', 'conversation']);

// Every capability is a required boolean so consumers never guess at defaults.
const CAPABILITIES = Object.freeze([
  'canDiscoverConversations', // listConversations() returns the user's existing conversations.
  'canConfirmDelivery', // A stable per-turn key lets findDelivery() prove whether a turn arrived.
  'canDetectUserActivity', // inspectConversation() reports the latest user message time.
  'canDetectCompletion', // checkTurn() or a submit completion reports when the agent finished.
  'canDetectUsageLimit', // probeAvailability() or turn outcomes report provider usage limits.
  'canReportResetTime', // Usage-limit signals include when the limit resets.
  'requiresRunningApp', // The harness app or server must already be running.
  'requiresUnlockedScreen', // Delivery drives a UI, so the Mac must be awake and unlocked.
  'requiresAccessibilityPermission' // Delivery needs macOS Accessibility permission.
]);

const REQUIRED_METHODS = Object.freeze(['checkConnection', 'listConversations', 'inspectConversation', 'prepareTurn', 'submitTurn', 'findDelivery']);
const OPTIONAL_METHODS = Object.freeze(['checkTurn', 'probeAvailability', 'shutdown']);
const SETTING_TYPES = new Set(['port', 'secret', 'text']);
const TURN_STATES = Object.freeze(['running', 'completed', 'failed', 'interrupted', 'unknown']);
const AVAILABILITY_STATES = Object.freeze(['available', 'limited', 'unavailable', 'unknown']);

function fail(id, problem) {
  throw new TypeError(`Harness "${id}" does not satisfy the adapter contract: ${problem}.`);
}

function validateSetting(id, setting) {
  if (!setting || typeof setting !== 'object') fail(id, 'settings entries must be objects');
  if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(setting.key || '')) fail(id, 'setting keys must be short identifiers');
  if (!SETTING_TYPES.has(setting.type)) fail(id, `setting "${setting.key}" has an unsupported type`);
  if (typeof setting.label !== 'string' || !setting.label) fail(id, `setting "${setting.key}" needs a label`);
  return Object.freeze({ key: setting.key, type: setting.type, label: setting.label, help: setting.help || '', env: setting.env || null, default: setting.default ?? (setting.type === 'port' ? null : '') });
}

// Validates and freezes an adapter. Unknown extra properties are allowed so
// adapters can expose test hooks, but contract fields must be exact.
function defineHarness(spec) {
  const id = spec?.id;
  if (!HARNESS_ID.test(id || '')) fail(String(id), 'id must be a lowercase slug');
  if (typeof spec.label !== 'string' || !spec.label.trim()) fail(id, 'label is required');
  if (!KINDS.has(spec.kind)) fail(id, 'kind must be local-api, cli or desktop-app');
  if (!NOUNS.has(spec.conversationNoun)) fail(id, 'conversationNoun must be thread, session or conversation');
  const capabilities = {};
  for (const name of CAPABILITIES) {
    if (typeof spec.capabilities?.[name] !== 'boolean') fail(id, `capability ${name} must be a boolean`);
    capabilities[name] = spec.capabilities[name];
  }
  for (const name of Object.keys(spec.capabilities)) if (!CAPABILITIES.includes(name)) fail(id, `unknown capability ${name}`);
  for (const name of REQUIRED_METHODS) if (typeof spec[name] !== 'function') fail(id, `${name}() is required`);
  for (const name of OPTIONAL_METHODS) if (spec[name] !== undefined && typeof spec[name] !== 'function') fail(id, `${name} must be a function when present`);
  if (capabilities.canDetectCompletion && typeof spec.checkTurn !== 'function') fail(id, 'canDetectCompletion requires checkTurn()');
  if (capabilities.canDetectUsageLimit && typeof spec.probeAvailability !== 'function') fail(id, 'canDetectUsageLimit requires probeAvailability()');
  if (capabilities.canReportResetTime && !capabilities.canDetectUsageLimit) fail(id, 'canReportResetTime requires canDetectUsageLimit');
  const settings = Object.freeze((spec.settings || []).map((setting) => validateSetting(id, setting)));
  return Object.freeze({ ...spec, capabilities: Object.freeze(capabilities), settings, description: spec.description || '' });
}

// Public, serialisable metadata used by IPC, the renderer and other features.
function describeHarness(adapter) {
  return {
    id: adapter.id, label: adapter.label, kind: adapter.kind, conversationNoun: adapter.conversationNoun,
    description: adapter.description, capabilities: { ...adapter.capabilities },
    settings: adapter.settings.map((setting) => ({ key: setting.key, type: setting.type, label: setting.label, help: setting.help, env: setting.env, default: setting.default }))
  };
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

// Normalises a conversation list entry. Unknown settlement stays visible (null).
function conversation(harness, value) {
  const settled = value.settled === true ? true : value.settled === false ? false : null;
  return {
    harness, id: String(value.id), title: String(value.title || '').trim() || '(Untitled)',
    projectId: String(value.projectId || ''), projectName: String(value.projectName || value.projectId || ''),
    updatedAt: isoOrNull(value.updatedAt), state: value.state || (settled === true ? 'settled' : settled === false ? 'active' : 'unknown'), settled,
    // Optional short label for how the conversation was created, such as Codex's `exec`.
    source: typeof value.source === 'string' && /^[A-Za-z][\w-]{0,31}$/.test(value.source) ? value.source : null
  };
}

function conversationState(value) {
  return {
    id: String(value.id), title: String(value.title || '').trim() || '(Untitled)',
    projectId: String(value.projectId || ''), projectName: String(value.projectName || value.projectId || ''),
    archived: value.archived === true, latestUserActivityAt: isoOrNull(value.latestUserActivityAt),
    delivered: value.delivered === true, busy: typeof value.busy === 'boolean' ? value.busy : null,
    // True when the agent is blocked on the user (question, approval or plan confirmation); null is unknown and never blocks.
    awaitingInput: typeof value.awaitingInput === 'boolean' ? value.awaitingInput : null, context: value.context
  };
}

function availability(value = {}) {
  return {
    state: AVAILABILITY_STATES.includes(value.state) ? value.state : 'unknown',
    resetsAt: isoOrNull(value.resetsAt), reason: String(value.reason || ''),
    source: ['reported', 'inferred'].includes(value.source) ? value.source : 'none',
    checkedAt: isoOrNull(value.checkedAt) || new Date().toISOString()
  };
}

function turnOutcome(value = {}) {
  return {
    state: TURN_STATES.includes(value.state) ? value.state : 'unknown',
    turnId: value.turnId ? String(value.turnId) : null,
    completedAt: isoOrNull(value.completedAt), error: value.error || null,
    usageLimit: value.usageLimit ? { resetsAt: isoOrNull(value.usageLimit.resetsAt), message: String(value.usageLimit.message || '') } : null
  };
}

module.exports = {
  AVAILABILITY_STATES, CAPABILITIES, CONTRACT_VERSION, OPTIONAL_METHODS, REQUIRED_METHODS, TURN_STATES,
  availability, conversation, conversationState, defineHarness, describeHarness, isoOrNull, turnOutcome
};
