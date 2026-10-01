'use strict';

// Structured, sanitized failure shared by every harness adapter.
// `deliveryUncertain` is true only when the turn may have reached the harness.
class HarnessError extends Error {
  constructor(code, message, details = {}, deliveryUncertain = false) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.details = details;
    this.deliveryUncertain = deliveryUncertain;
  }
}

const ERROR_CODES = new Set([
  'missing_credentials', 'authentication_rejected', 'awaiting_input', 'connection_refused', 'timeout', 'http_failure',
  'unexpected_response_format', 'unsupported_response_shape', 'conversation_not_found', 'conversation_busy',
  'harness_not_installed', 'harness_not_configured', 'owned_by_other_harness', 'process_failed', 'usage_limited', 'unknown_harness',
  'permission_required', 'screen_locked', 'app_version_unsupported', 'unexpected'
]);

// Stable IDs for the undocumented details of a desktop app that an update can
// break, with how a change to each reads in a sentence. Adapters name one in
// `details.contactPoint` so logs, the dashboard and bug reports say what broke.
const CONTACT_POINTS = Object.freeze({
  app_path: 'where it keeps the files Agent Auto-Continue reads',
  deep_link: 'how its links open a conversation',
  content_match: 'how it shows which conversation is open',
  composer_label: 'how its message box is labelled',
  send_label: 'how its send button is labelled',
  stop_label: 'how its stop button is labelled',
  label_catalogue: 'how it stores its translated labels',
  session_store: 'how it stores its sessions',
  live_registry: 'how it reports whether the agent is working',
  transcript: 'how it records conversations',
  originator: 'how it marks the conversations it created',
  app_server: 'how its built-in Codex server answers'
});

// One sentence naming the app, its version and what changed. `sending` says
// whether this stopped a send (certainly nothing was sent) or came from a check.
function driftMessage({ app, appVersion = null, verifiedVersion = null, contactPoint, sending = true }) {
  const name = appVersion ? `${app} ${appVersion}` : app;
  const what = CONTACT_POINTS[contactPoint] || 'something Agent Auto-Continue relies on';
  // The verified version itself can still differ, for example in another interface language.
  const lead = appVersion && appVersion === verifiedVersion ? `${name} did not match what this version of Agent Auto-Continue expects for ${what}` : `${name} changed ${what}`;
  return sending ? `${lead}, so Agent Auto-Continue could not send. Nothing was sent.` : `${lead}. Scheduled messages for it may fail until Agent Auto-Continue supports this version.`;
}

// The app changed in a way this version of Agent Auto-Continue does not
// understand. Throw it only before anything could reach the app: it is always
// a certain non-delivery. `hint` is a short technical note for bug reports; it
// is redacted and must never contain message text.
function appVersionUnsupported({ app, appVersion = null, verifiedVersion = null, contactPoint, hint = '' }) {
  const point = CONTACT_POINTS[contactPoint] ? contactPoint : 'unknown';
  return new HarnessError('app_version_unsupported', driftMessage({ app, appVersion, verifiedVersion, contactPoint: point }),
    { app: String(app), appVersion: appVersion || null, verifiedVersion: verifiedVersion || null, contactPoint: point, hint: redact(hint).slice(0, 300) }, false);
}

function toErrorInfo(error) {
  if (error instanceof HarnessError) return { code: error.code, message: error.message, details: error.details, deliveryUncertain: error.deliveryUncertain };
  return { code: 'unexpected', message: 'The operation could not be completed. Check the connection and try again.', details: {}, deliveryUncertain: false };
}

// Removes values that look like credentials before text reaches logs or the UI.
function redact(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) value = value.split(secret).join('[redacted]');
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+_-]{32,}={0,2}/g, (match) => (/\d/.test(match) && /[A-Za-z]/.test(match) ? '[redacted]' : match));
}

module.exports = { CONTACT_POINTS, ERROR_CODES, HarnessError, appVersionUnsupported, driftMessage, redact, toErrorInfo };
