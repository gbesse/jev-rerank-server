// Purpose: node:http server exposing /v1/rerank, /v2/rerank, /healthz and /v1/models with structured JSON errors.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { JEV_MODEL, JevError } from './jev-client.mjs';
import { MODEL_ALIASES, RerankValidationError, rerank, validatePack } from './rerank.mjs';
import { createLimiter } from './concurrency.mjs';
import { createMetrics } from './metrics.mjs';

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const RERANK_PATHS = new Set(['/v1/rerank', '/v2/rerank', '/rerank']);

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function sendText(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

/** Compare bearer tokens in constant time; length leaks are acceptable, byte-by-byte early exit is not. */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(request) {
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && /^bearer /i.test(auth)) return auth.slice(7).trim();
  // Cohere's older clients send X-API-Key rather than a bearer header.
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' ? apiKey.trim() : null;
}

async function readJsonBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) { const error = new RerankValidationError(`Request body exceeds ${maxBodyBytes} bytes`); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RerankValidationError('Request body is not valid JSON');
  }
}

/** Map an error to a status and a client-safe message; anything unknown is a 500 with a fixed message so internals never leak. */
export function describeError(error) {
  if (error instanceof RerankValidationError) return { status: error.status, message: error.message };
  if (error instanceof JevError) {
    if (error.code === 'timeout') return { status: 504, message: `Jev request timed out: ${error.message}` };
    return { status: 502, message: `Jev request failed: ${error.message}` };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { status: 504, message: 'Request aborted before Jev answered' };
  return { status: 500, message: 'Internal error' };
}

/**
 * Build the server. `provider` is any Jev-contract provider (real client or fake); `token`, when set, is required as
 * `Authorization: Bearer` (or `X-API-Key`) on rerank calls. `/healthz` and `/v1/models` stay open so probes work.
 */
export function createRerankServer({ provider, token = null, pack = 1, limiter = createLimiter(), cache, metrics = createMetrics(), log = message => console.error(message), maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (typeof provider !== 'function') throw new TypeError('provider is required');
  if (token !== null && (typeof token !== 'string' || token.length === 0)) throw new TypeError('token must be a non-empty string or null');
  validatePack(pack);

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true, model: provider.model ?? JEV_MODEL, pack, cache: cache ? { enabled: true, ttl_ms: cache.ttlMs, max_entries: cache.maxEntries, entries: cache.size } : { enabled: false } });
    if (request.method === 'GET' && url.pathname === '/metrics') {
      if (token !== null && !tokenMatches(presentedToken(request), token)) return send(response, 401, { message: 'Missing or invalid bearer token' });
      return sendText(response, 200, metrics.render());
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return send(response, 200, {
        object: 'list',
        data: [provider.model ?? JEV_MODEL, ...MODEL_ALIASES].map(id => ({ id, object: 'model', owned_by: id === (provider.model ?? JEV_MODEL) ? 'configured-provider' : 'alias', served_by: provider.model ?? JEV_MODEL })),
        note: 'Any other model name is accepted on /v1/rerank and /v2/rerank and served by the configured model.',
      });
    }
    if (!RERANK_PATHS.has(url.pathname)) return send(response, 404, { message: `No route for ${request.method} ${url.pathname}` });
    if (request.method !== 'POST') return send(response, 405, { message: 'Use POST' });
    if (token !== null && !tokenMatches(presentedToken(request), token)) return send(response, 401, { message: 'Missing or invalid bearer token' });
    const body = await readJsonBody(request, maxBodyBytes);
    const result = await rerank(body, { provider, pack, limiter, cache });
    send(response, 200, result);
    return { usage: result.usage, documents: body.documents.length };
  }

  return createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const measured = request.method === 'POST' && RERANK_PATHS.has(pathname);
    const started = process.hrtime.bigint();
    if (measured) metrics.begin();
    handle(request, response).then(result => {
      if (measured) metrics.finish({ status: response.statusCode, durationSeconds: Number(process.hrtime.bigint() - started) / 1e9, ...result });
    }).catch(error => {
      const { status, message } = describeError(error);
      // Unexpected failures are worth a full stack on stderr; expected client errors are noise there.
      if (status >= 500) log(`[jev-rerank-server] ${request.method} ${request.url} -> ${status}: ${status === 500 ? (error?.stack ?? error) : message}`);
      if (!response.headersSent) send(response, status, { message });
      else response.destroy();
      if (measured) metrics.finish({ status, durationSeconds: Number(process.hrtime.bigint() - started) / 1e9 });
    });
  });
}
