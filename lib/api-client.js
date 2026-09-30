'use strict';

const { HarnessError, toErrorInfo } = require('./harnesses/errors');

// T3 Code transport errors keep their historical class name for callers and tests.
class ApiError extends HarnessError {
  constructor(code, message, details = {}, deliveryUncertain = false) {
    super(code, message, details, deliveryUncertain);
    this.name = 'ApiError';
  }
}

function createApiClient({ getConfig, getToken, fetchImpl = fetch, timeoutMs = 10_000 }) {
  async function request(endpoint, options = {}) {
    const credential = getToken();
    if (!credential) throw new ApiError('missing_credentials', 'Add a T3 token in Settings or set T3_TOKEN before starting the app.');
    const posting = options.method === 'POST';
    const details = { endpoint: endpoint.split('?')[0], port: getConfig().httpPort };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${getConfig().httpPort}/api/orchestration/${endpoint}`, {
        ...options, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${credential}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
      });
      details.status = response.status;
      details.contentType = (response.headers.get('content-type') || '').split(';')[0].slice(0, 80);
      const body = await response.text();
      if (!response.ok) {
        const auth = response.status === 401 || response.status === 403;
        throw new ApiError(auth ? 'authentication_rejected' : 'http_failure', auth ? 'T3 Code rejected the token. Check Settings.' : `T3 Code returned HTTP ${response.status}. Check the connection and API compatibility.`, details, posting && !auth);
      }
      if (/^\s*</.test(body) || details.contentType === 'text/html') {
        throw new ApiError('unexpected_response_format', 'T3 Code returned a webpage instead of the expected API response. Check the connection settings and API compatibility.', details, posting);
      }
      if (!body || (details.contentType && !/^application\/(?:[\w.+-]*\+)?json$/i.test(details.contentType))) {
        throw new ApiError('unexpected_response_format', 'T3 Code did not return the expected JSON response. Check API compatibility.', details, posting);
      }
      try { return JSON.parse(body); } catch {
        throw new ApiError('unexpected_response_format', 'T3 Code returned an unreadable API response. Check API compatibility.', details, posting);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.name === 'AbortError') throw new ApiError('timeout', 'T3 Code did not respond in time. Check the connection.', details, posting);
      throw new ApiError('connection_refused', 'Cannot connect to T3 Code. Check that it is running and the port in Settings is correct.', details, posting);
    } finally { clearTimeout(timeout); }
  }
  function shapeError(endpoint, uncertain = false) {
    return new ApiError('unsupported_response_shape', 'T3 Code returned an unsupported API response. Check API compatibility.', { endpoint }, uncertain);
  }
  return {
    request,
    async fetchSnapshot() {
      const result = await request('snapshot');
      if (!result || !Array.isArray(result.threads) || (result.projects !== undefined && !Array.isArray(result.projects))) throw shapeError('snapshot');
      return result;
    },
    async fetchThread(id) {
      const result = await request(`threads/${encodeURIComponent(id)}?turnLimit=200`);
      const thread = result?.thread || result;
      if (!thread || thread.id !== id || !Array.isArray(thread.messages)) throw shapeError('threads');
      return thread;
    },
    async dispatch(command) {
      const result = await request('dispatch', { method: 'POST', body: JSON.stringify(command) });
      // Only a verified acceptance response may become a delivery success.
      if (!result || (!Number.isInteger(result.sequence) || result.sequence < 0)) throw shapeError('dispatch', true);
      return result;
    }
  };
}
module.exports = { ApiError, createApiClient, toErrorInfo };
