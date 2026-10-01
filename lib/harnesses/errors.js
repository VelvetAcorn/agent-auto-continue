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
  'harness_not_installed', 'harness_not_configured', 'owned_by_other_harness', 'process_failed', 'usage_limited', 'unknown_harness', 'unexpected'
]);

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

module.exports = { ERROR_CODES, HarnessError, redact, toErrorInfo };
