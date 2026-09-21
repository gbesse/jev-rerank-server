// Purpose: Zero-dependency Jev client (retries, timeouts, strict response validation, cost estimate) plus an offline fake provider.
import { setTimeout as sleep } from 'node:timers/promises';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Published price list on 21 Sept 2026: USD 0.042 per million input tokens, output free. */
export const INPUT_USD_PER_MILLION_TOKENS = 0.042;
export const DEFAULT_STATE_TOKEN_BUDGET = 24_000;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** Error raised for every failure between "request built" and "response validated". `status` is Jev's HTTP status when there was one. */
export class JevError extends Error {
  constructor(message, { status = null, code = 'jev_error', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'JevError';
    this.status = status;
    this.code = code;
  }
}

function ensure(condition, message, options) {
  if (!condition) throw new JevError(message, options);
}

/** Rough size estimate used to refuse oversized states before spending tokens; four characters per token is the documented rule of thumb. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Math.ceil(text.length / 4);
}

/** Estimate from the published price list; not a bill. Output tokens are free, so only input tokens count. Rounded to nanodollars so JSON output stays readable. */
export function estimateCostUsd(inputTokens) {
  return Math.round(inputTokens * INPUT_USD_PER_MILLION_TOKENS * 1e3) / 1e9;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export function validateQuestions(questions) {
  ensure(isObject(questions) && Object.keys(questions).length > 0, 'questions must be a non-empty object', { code: 'invalid_questions' });
  for (const [id, question] of Object.entries(questions)) {
    ensure(isObject(question) && ['noul', 'choice', 'score'].includes(question.type), `question ${id}: type must be noul, choice or score`, { code: 'invalid_questions' });
    ensure(question.instructions !== undefined && question.instructions !== '', `question ${id}: instructions are required`, { code: 'invalid_questions' });
    if (question.type === 'choice') ensure(isObject(question.criteria) && Object.keys(question.criteria).length >= 1 && Object.keys(question.criteria).length <= 255, `question ${id}: choice criteria must map 1 to 255 options`, { code: 'invalid_questions' });
    if (question.type === 'score') ensure(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, `question ${id}: score criteria must list 2 to 10 levels`, { code: 'invalid_questions' });
  }
}

/**
 * Strict contract check. Anything that does not match the declared question types is an error:
 * silently coercing a malformed answer would turn a provider bug into a wrong ranking.
 */
export function validateResponse(response, { model, questions }) {
  const fail = (message) => { throw new JevError(`Invalid Jev response: ${message}`, { code: 'invalid_response' }); };
  if (!isObject(response)) fail('body is not an object');
  if (response.model !== model) fail(`model mismatch, requested ${model} but received ${String(response.model)}`);
  if (!isObject(response.answers)) fail('answers missing');
  const extra = Object.keys(response.answers).filter(id => !(id in questions));
  if (extra.length) fail(`unexpected answers ${extra.join(', ')}`);
  for (const [id, question] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!isObject(answer)) fail(`answer ${id} missing`);
    if (answer.type !== question.type) fail(`answer ${id} has type ${String(answer.type)}, expected ${question.type}`);
    if (question.type === 'noul') {
      if (!isProbability(answer.noul)) fail(`answer ${id}: noul must be a number in [0,1]`);
      continue;
    }
    if (!isProbability(answer.confidence)) fail(`answer ${id}: confidence must be a number in [0,1]`);
    if (!isObject(answer.probabilities)) fail(`answer ${id}: probabilities missing`);
    const allowed = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    for (const [key, p] of Object.entries(answer.probabilities)) {
      if (!allowed.includes(key)) fail(`answer ${id}: probability for unknown option ${key}`);
      if (!isProbability(p)) fail(`answer ${id}: probability for ${key} must be in [0,1]`);
    }
    if (question.type === 'choice' && !allowed.includes(answer.choice)) fail(`answer ${id}: choice ${String(answer.choice)} is not one of the criteria`);
    if (question.type === 'score' && !(typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1)) fail(`answer ${id}: score out of range`);
  }
  if (!isObject(response.usage) || !(Number.isInteger(response.usage.input_tokens) && response.usage.input_tokens >= 0)) fail('usage.input_tokens missing');
  const outputTokens = response.usage.output_tokens ?? 0;
  if (!(Number.isInteger(outputTokens) && outputTokens >= 0)) fail('usage.output_tokens invalid');
  return { model: response.model, answers: response.answers, usage: { input_tokens: response.usage.input_tokens, output_tokens: outputTokens } };
}

/** Parse `retry-after` (seconds or HTTP date) into milliseconds; null when absent or unparseable. */
function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * Build a provider `({ state, questions, signal }) => Promise<{ model, answers, usage }>` talking to the real endpoint.
 * Retries only 429, 529 and network failures; timeouts and caller aborts are never retried because the caller's deadline
 * is the real constraint. The key is redacted from every error message so it cannot reach HTTP responses or logs.
 */
export function createJevClient({
  apiKey = process.env.TYPESAFE_API_KEY,
  endpoint = JEV_ENDPOINT,
  model = JEV_MODEL,
  timeoutMs = 30_000,
  maxRetries = 2,
  fetchImpl = globalThis.fetch,
  stateTokenBudget = DEFAULT_STATE_TOKEN_BUDGET,
  retryBaseMs = 250,
  maxRetryDelayMs = 30_000,
} = {}) {
  ensure(typeof apiKey === 'string' && apiKey.length > 0, 'Set TYPESAFE_API_KEY to call Jev', { code: 'missing_key' });
  ensure(typeof model === 'string' && model.startsWith('jev-') && model !== 'jev-latest', 'Pin an explicit model version such as jev-1.13.0', { code: 'invalid_model' });
  ensure(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000, 'timeoutMs must be between 1 and 300000', { code: 'invalid_option' });
  ensure(Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 10, 'maxRetries must be between 0 and 10', { code: 'invalid_option' });
  ensure(typeof fetchImpl === 'function', 'fetchImpl must be a function', { code: 'invalid_option' });
  const url = new URL(endpoint);
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)), 'Endpoint must use HTTPS (loopback HTTP allowed for tests)', { code: 'invalid_endpoint' });
  ensure(!url.username && !url.password, 'Endpoint cannot contain credentials', { code: 'invalid_endpoint' });
  const redact = text => String(text).split(apiKey).join('[redacted]');

  async function backoff(attempt, header, signal) {
    const jittered = retryBaseMs * 2 ** attempt * (0.5 + Math.random());
    const wait = Math.min(maxRetryDelayMs, retryAfterMs(header) ?? jittered);
    await sleep(wait, undefined, signal ? { signal } : undefined);
  }

  return async function ask({ state, questions, signal } = {}) {
    validateQuestions(questions);
    ensure(state !== undefined, 'state is required', { code: 'invalid_state' });
    const stateTokens = estimateTokens(state);
    ensure(stateTokens <= stateTokenBudget, `State estimate of ${stateTokens} tokens exceeds the budget of ${stateTokenBudget}`, { code: 'state_budget' });
    const body = JSON.stringify({ model, state, questions });
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: combined,
        });
      } catch (error) {
        if (timeout.aborted) throw new JevError(`Jev request timed out after ${timeoutMs} ms`, { code: 'timeout', cause: error });
        if (signal?.aborted) throw signal.reason;
        if (attempt < maxRetries) { await backoff(attempt, null, signal); continue; }
        throw new JevError(`Jev network error: ${redact(error?.message ?? error)}`, { code: 'network', cause: error });
      }
      if (response.status === 429 || response.status === 529) {
        // Drain the body so the connection can be reused, then back off; the header wins over our own schedule.
        await response.arrayBuffer().catch(() => undefined);
        const code = response.status === 429 ? 'rate_limited' : 'overloaded';
        if (attempt < maxRetries) { await backoff(attempt, response.headers.get('retry-after'), signal); continue; }
        throw new JevError(`Jev HTTP ${response.status} after ${attempt + 1} attempts`, { status: response.status, code });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new JevError(`Jev HTTP ${response.status}${text ? `: ${redact(text.slice(0, 300))}` : ''}`, { status: response.status, code: response.status === 401 ? 'unauthorized' : response.status === 422 ? 'validation' : 'http_error' });
      }
      let json;
      try { json = await response.json(); } catch (error) { throw new JevError('Jev returned a non-JSON body', { status: response.status, code: 'invalid_response', cause: error }); }
      return validateResponse(json, { model, questions });
    }
  };
}

/**
 * Offline provider with the same contract. `fixtures` is either a static `{ answers, usage? }` object or a function
 * receiving `{ model, state, questions }` and returning answers (or `{ answers, usage }`). Answers are validated exactly
 * like a real response so a broken fixture fails loudly instead of producing a plausible ranking.
 */
export function createFakeProvider(fixtures, { model = JEV_MODEL } = {}) {
  ensure(typeof fixtures === 'function' || isObject(fixtures), 'fixtures must be a function or an object', { code: 'invalid_option' });
  const resolve = typeof fixtures === 'function' ? fixtures : () => fixtures;
  return async function ask({ state, questions, signal } = {}) {
    signal?.throwIfAborted();
    validateQuestions(questions);
    const produced = await resolve({ model, state, questions });
    const answers = isObject(produced) && isObject(produced.answers) ? produced.answers : produced;
    const usage = (isObject(produced) && isObject(produced.usage)) ? produced.usage : { input_tokens: estimateTokens({ state, questions }), output_tokens: 0 };
    return validateResponse({ model, answers, usage }, { model, questions });
  };
}
