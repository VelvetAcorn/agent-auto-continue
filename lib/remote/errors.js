'use strict';

/** A failure with a stable machine-readable code and an HTTP status. */
class RemoteError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'RemoteError';
    Object.assign(this, { status, code, details });
  }
}

// Harness failures (ApiError today, HarnessError once adapters land) carry a code, sanitized
// details and a deliveryUncertain flag; their messages are written for users.
function isHarnessError(error) {
  return error instanceof Error && typeof error.code === 'string' && typeof error.deliveryUncertain === 'boolean';
}

/**
 * Maps any failure from the shared scheduler path to a RemoteError.
 * Plain Errors come from the same validation the desktop UI uses, so their wording is user-facing.
 * Anything else is reported generically so internal details never leave the Mac.
 */
function toRemoteError(error) {
  if (error instanceof RemoteError) return error;
  if (error?.code === 'unknown_harness') return new RemoteError(400, 'unknown_harness', error.message);
  if (isHarnessError(error)) {
    const upstream = { code: error.code, message: error.message, details: error.details || {} };
    if (error.code === 'conversation_not_found' || error.details?.status === 404) return new RemoteError(404, 'thread_not_found', 'That thread is no longer available in the agent harness.', { upstream });
    return new RemoteError(502, 'harness_unavailable', error.message, { upstream });
  }
  if (error?.code === 'not_found') return new RemoteError(404, 'job_not_found', error.message);
  if (error?.code === 'invalid_state') return new RemoteError(409, 'invalid_state', error.message);
  if (error?.code === 'storage_unavailable') return new RemoteError(503, 'storage_unavailable', error.message);
  if (typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
    return new RemoteError(503, 'storage_unavailable', 'Local schedule storage could not be updated. Check disk space on the Mac.');
  }
  if (error && Object.getPrototypeOf(error) === Error.prototype && typeof error.message === 'string') {
    return new RemoteError(400, 'validation_failed', error.message);
  }
  return new RemoteError(500, 'internal_error', 'The desktop app could not complete the request.');
}

function errorBody(error) {
  return { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
}

module.exports = { RemoteError, errorBody, toRemoteError };
