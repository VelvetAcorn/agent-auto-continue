'use strict';

const { RemoteError } = require('./errors');

// [method, path pattern, operation, where the input comes from, path parameter name]
const ROUTES = [
  ['GET', /^\/v1\/status$/, 'status', 'none'],
  ['GET', /^\/v1\/harnesses$/, 'listHarnesses', 'none'],
  ['GET', /^\/v1\/harnesses\/([^/]+)\/connection$/, 'checkConnection', 'none', 'harness'],
  ['GET', /^\/v1\/harnesses\/([^/]+)\/availability$/, 'getAvailability', 'none', 'harness'],
  ['GET', /^\/v1\/threads$/, 'listThreads', 'query'],
  ['GET', /^\/v1\/projects$/, 'listProjects', 'query'],
  ['GET', /^\/v1\/jobs$/, 'listJobs', 'query'],
  ['POST', /^\/v1\/jobs$/, 'createJob', 'body'],
  ['GET', /^\/v1\/jobs\/([^/]+)$/, 'getJob', 'none'],
  ['PATCH', /^\/v1\/jobs\/([^/]+)$/, 'editJob', 'body'],
  ['POST', /^\/v1\/jobs\/([^/]+)\/cancel$/, 'cancelJob', 'none'],
  ['POST', /^\/v1\/jobs\/([^/]+)\/acknowledge$/, 'acknowledgeJob', 'none'],
  ['POST', /^\/v1\/jobs\/([^/]+)\/reconcile$/, 'reconcileJob', 'none'],
  ['GET', /^\/v1\/runs$/, 'listRuns', 'none'],
  ['POST', /^\/v1\/runs\/([^/]+)\/stop$/, 'stopRun', 'none']
];
const INTEGER_PARAMS = new Set(['limit', 'offset']);
const BOOLEAN_PARAMS = new Set(['showSettled']);

function matchRoute(method, pathname) {
  const candidates = ROUTES.map(([routeMethod, pattern, operation, source, param = 'id']) => ({ routeMethod, match: pattern.exec(pathname), operation, source, param })).filter((route) => route.match);
  if (!candidates.length) throw new RemoteError(404, 'not_found', 'No API resource exists at this path.');
  const route = candidates.find((candidate) => candidate.routeMethod === method);
  if (!route) throw new RemoteError(405, 'method_not_allowed', `Use ${candidates.map((candidate) => candidate.routeMethod).join(' or ')} for this resource.`, { allow: candidates.map((candidate) => candidate.routeMethod) });
  let id;
  if (route.match[1] !== undefined) {
    try { id = decodeURIComponent(route.match[1]); } catch { throw new RemoteError(400, 'validation_failed', 'The identifier in the path is not valid.'); }
  }
  return { ...route, id };
}

function queryInput(searchParams) {
  const input = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    if (values.length > 1) throw new RemoteError(400, 'validation_failed', `Query parameter "${key}" may only appear once.`);
    const [value] = values;
    input[key] = INTEGER_PARAMS.has(key) && /^-?\d{1,9}$/.test(value) ? Number(value) :
      BOOLEAN_PARAMS.has(key) && ['true', 'false'].includes(value) ? value === 'true' : value;
  }
  return input;
}

function bodyInput(headers, raw) {
  if (!raw.length) return {};
  if (!/^application\/json\s*(?:;|$)/i.test(headers['content-type'] || '')) throw new RemoteError(415, 'unsupported_media_type', 'Send the request body as application/json.');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new RemoteError(400, 'invalid_json', 'The request body is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RemoteError(400, 'validation_failed', 'The request body must be a JSON object.');
  return value;
}

/**
 * Resolves an authenticated REST request to an operation call.
 * @returns {Promise<{status: number, body: object, headers?: object}>}
 */
async function handleApiRequest({ method, url, headers, body, operations, context }) {
  const route = matchRoute(method, url.pathname);
  if (route.source !== 'query' && [...url.searchParams.keys()].length) throw new RemoteError(400, 'validation_failed', 'This resource does not accept query parameters.');
  const input = route.source === 'query' ? queryInput(url.searchParams) : bodyInput(headers, body);
  if (route.source === 'none' && Object.keys(input).length) throw new RemoteError(400, 'validation_failed', 'This action does not accept a request body.');
  if (route.id !== undefined) {
    if (input[route.param] !== undefined) throw new RemoteError(400, 'validation_failed', `The ${route.param} belongs in the URL path, not the body.`);
    input[route.param] = route.id;
  }
  if (route.operation === 'createJob' && headers['idempotency-key'] !== undefined) {
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== headers['idempotency-key']) throw new RemoteError(400, 'validation_failed', 'The Idempotency-Key header and idempotencyKey field differ.');
    input.idempotencyKey = headers['idempotency-key'];
  }
  const result = await operations.run(route.operation, input, context);
  if (route.operation === 'createJob') return { status: result.replayed ? 200 : 201, body: result, headers: result.replayed ? { 'Idempotent-Replayed': 'true' } : {} };
  return { status: 200, body: result };
}

module.exports = { ROUTES, handleApiRequest };
