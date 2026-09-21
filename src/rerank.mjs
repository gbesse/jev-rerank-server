// Purpose: Rerank request normalization, Jev scoring (pairwise or packed) and Cohere/Jina/Voyage response shaping.
import { randomUUID } from 'node:crypto';
import { JEV_MODEL, estimateCostUsd, createFakeProvider } from './jev-client.mjs';

export const LIMITS = Object.freeze({ maxDocuments: 1000, maxDocumentChars: 20_000, maxQueryChars: 4000, maxPack: 20 });
/** Model names any Cohere, Jina or Voyage client may send; all are served by the pinned Jev model. */
export const MODEL_ALIASES = Object.freeze(['jev-latest', 'rerank-v3.5', 'rerank-english-v3.0', 'rerank-multilingual-v3.0', 'jina-reranker-v2-base-multilingual', 'jina-reranker-v1-base-en', 'rerank-2', 'rerank-2-lite', 'rerank-lite-1']);

/** Wording taken from TypeSafe's rerank cookbook: one Noul per (query, passage) pair. */
export const RELEVANCE_INSTRUCTIONS = 'Does the passage directly answer the query or contain the specific information the query asks for?';
export const RELEVANCE_CRITERIA = Object.freeze({
  true: 'The passage states the specific fact, answer or content the query is looking for.',
  false: 'The passage is only on a related topic, mentions the same words, or does not contain what the query asks for.',
});

/** 400-class error: the client sent something the protocol does not accept. */
export class RerankValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RerankValidationError';
    this.status = 400;
  }
}

const reject = message => { throw new RerankValidationError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function documentText(document, position, rankFields) {
  if (typeof document === 'string') return document;
  if (!isObject(document)) reject(`documents[${position}] must be a string or an object`);
  if (rankFields) {
    // Cohere v2 semantics: only the named fields are ranked, in the order given, as "field: value" lines.
    const lines = rankFields.filter(field => typeof document[field] === 'string' && document[field] !== '').map(field => `${field}: ${document[field]}`);
    if (!lines.length) reject(`documents[${position}] has none of the rank_fields as text`);
    return lines.join('\n');
  }
  if (typeof document.text === 'string') return document.text;
  const lines = Object.entries(document).filter(([, value]) => typeof value === 'string' && value !== '').map(([key, value]) => `${key}: ${value}`);
  if (!lines.length) reject(`documents[${position}] has no text field and no string fields`);
  return lines.join('\n');
}

function positiveInteger(value, name) {
  if (value === undefined || value === null) return null;
  if (!(Number.isInteger(value) && value >= 1)) reject(`${name} must be a positive integer`);
  return value;
}

/**
 * Turn any Cohere v1/v2, Jina or Voyage request body into one internal shape. Oversized documents are truncated and
 * flagged instead of rejected because a retrieval pipeline cannot usually shorten a stored chunk on the fly.
 */
export function normalizeRerankRequest(body) {
  if (!isObject(body)) reject('Request body must be a JSON object');
  const { model, query, documents, top_n: topN, top_k: topK, return_documents: returnDocuments, rank_fields: rankFields, max_chunks_per_doc: maxChunks } = body;
  if (model !== undefined && typeof model !== 'string') reject('model must be a string');
  if (typeof query !== 'string' || query.trim() === '') reject('query is required and must be a non-empty string');
  if (query.length > LIMITS.maxQueryChars) reject(`query exceeds ${LIMITS.maxQueryChars} characters`);
  if (!Array.isArray(documents)) reject('documents must be an array');
  if (documents.length > LIMITS.maxDocuments) reject(`documents exceeds the maximum of ${LIMITS.maxDocuments}`);
  if (rankFields !== undefined && !(Array.isArray(rankFields) && rankFields.length && rankFields.every(field => typeof field === 'string'))) reject('rank_fields must be a non-empty array of strings');
  if (returnDocuments !== undefined && typeof returnDocuments !== 'boolean') reject('return_documents must be a boolean');
  const warnings = [];
  if (maxChunks !== undefined) warnings.push('max_chunks_per_doc is ignored: each document is scored whole, truncated at 20000 characters');
  const limit = positiveInteger(topK, 'top_k') ?? positiveInteger(topN, 'top_n');
  const normalizedDocuments = documents.map((document, index) => {
    const full = documentText(document, index, rankFields);
    const truncated = full.length > LIMITS.maxDocumentChars;
    return { index, text: truncated ? full.slice(0, LIMITS.maxDocumentChars) : full, truncated, original: document };
  });
  return {
    model: model ?? JEV_MODEL,
    query,
    documents: normalizedDocuments,
    limit,
    returnDocuments: returnDocuments === true,
    // Only Voyage uses top_k, so its presence selects the Voyage response envelope.
    shape: topK !== undefined ? 'voyage' : 'cohere',
    warnings,
  };
}

export function buildPairwiseRequest(query, passage) {
  return { state: { query, passage }, questions: { relevant: { type: 'noul', instructions: RELEVANCE_INSTRUCTIONS, criteria: RELEVANCE_CRITERIA } } };
}

/** Packed mode: several passages share one state, one Noul each. Cheaper per document, less accurate (irrelevant state hurts Jev). */
export function buildPackedRequest(query, passages) {
  const state = { query, passages: {} };
  const questions = {};
  passages.forEach((text, position) => {
    const id = `p${position + 1}`;
    state.passages[id] = text;
    questions[id] = {
      type: 'noul',
      instructions: `Does passage ${id} directly answer the query or contain the specific information the query asks for?`,
      criteria: {
        true: `Passage ${id} states the specific fact, answer or content the query is looking for.`,
        false: `Passage ${id} is only on a related topic, mentions the same words, or does not contain what the query asks for.`,
      },
    };
  });
  return { state, questions };
}

export function validatePack(pack) {
  if (!(Number.isInteger(pack) && pack >= 1 && pack <= LIMITS.maxPack)) throw new RangeError(`pack must be an integer between 1 and ${LIMITS.maxPack}`);
  return pack;
}

/**
 * Score every text with the provider and return `scores[i]` aligned with `texts[i]`. One failure aborts the other
 * in-flight requests and rejects: a partial ranking would silently drop documents the caller expects to see.
 */
export async function scoreDocuments({ provider, query, texts, pack = 1, limiter, signal }) {
  validatePack(pack);
  if (typeof provider !== 'function') throw new TypeError('provider is required');
  const groups = [];
  for (let start = 0; start < texts.length; start += pack) groups.push(texts.slice(start, start + pack).map((_, offset) => start + offset));
  const internal = new AbortController();
  const combined = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  const run = limiter ? fn => limiter.run(fn) : fn => fn();
  const scores = new Array(texts.length).fill(null);
  const usage = { input_tokens: 0, output_tokens: 0, requests: 0 };
  try {
    await Promise.all(groups.map(group => run(async () => {
      combined.throwIfAborted();
      const request = pack > 1 ? buildPackedRequest(query, group.map(index => texts[index])) : buildPairwiseRequest(query, texts[group[0]]);
      const response = await provider({ ...request, signal: combined });
      usage.requests++;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      group.forEach((index, position) => { scores[index] = pack > 1 ? response.answers[`p${position + 1}`].noul : response.answers.relevant.noul; });
    })));
  } catch (error) {
    internal.abort(error);
    throw error;
  }
  return { scores, usage };
}

function returnedDocument(document, shape) {
  // Cohere returns the original object for object documents and { text } for strings; Voyage returns the bare string.
  if (shape === 'voyage') return document.text;
  return typeof document.original === 'string' ? { text: document.text } : document.original;
}

/** Sort by score descending; ties keep the caller's original order so results are deterministic across runs. */
export function rankResults(documents, scores) {
  return documents
    .map(document => ({ index: document.index, relevance_score: scores[document.index], truncated: document.truncated }))
    .sort((a, b) => (b.relevance_score - a.relevance_score) || (a.index - b.index));
}

export function buildRerankResponse(normalized, scores, usage) {
  const ranked = rankResults(normalized.documents, scores);
  const kept = normalized.limit === null ? ranked : ranked.slice(0, normalized.limit);
  const items = kept.map(({ index, relevance_score, truncated }) => {
    const item = { index, relevance_score };
    if (normalized.returnDocuments) item.document = returnedDocument(normalized.documents[index], normalized.shape);
    if (truncated) item.truncated = true;
    return item;
  });
  const estimatedCost = estimateCostUsd(usage.input_tokens);
  if (normalized.shape === 'voyage') {
    const response = { object: 'list', data: items, model: normalized.model, served_by: JEV_MODEL, usage: { total_tokens: usage.input_tokens + usage.output_tokens, jev_requests: usage.requests, estimated_cost_usd: estimatedCost } };
    if (normalized.warnings.length) response.warnings = normalized.warnings;
    return response;
  }
  const response = {
    id: randomUUID(),
    results: items,
    model: normalized.model,
    served_by: JEV_MODEL,
    usage: { total_tokens: usage.input_tokens + usage.output_tokens, prompt_tokens: usage.input_tokens, jev_requests: usage.requests, estimated_cost_usd: estimatedCost },
    meta: { api_version: { version: '2' }, billed_units: { search_units: 1 } },
  };
  if (normalized.warnings.length) response.meta.warnings = normalized.warnings;
  return response;
}

/** Full pipeline for one request body: validate, score, shape. Throws `RerankValidationError` or the provider's error. */
export async function rerank(body, { provider, pack = 1, limiter, signal } = {}) {
  const normalized = normalizeRerankRequest(body);
  if (normalized.documents.length === 0) return buildRerankResponse(normalized, [], { input_tokens: 0, output_tokens: 0, requests: 0 });
  const { scores, usage } = await scoreDocuments({ provider, query: normalized.query, texts: normalized.documents.map(document => document.text), pack, limiter, signal });
  return buildRerankResponse(normalized, scores, usage);
}

const tokens = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** Synthetic relevance for demos and tests: share of query words found in the passage. Not a model, not measured Jev output. */
export function syntheticRelevance(query, passage) {
  const wanted = tokens(query);
  if (!wanted.size) return 0;
  const found = tokens(passage);
  let hits = 0;
  for (const word of wanted) if (found.has(word)) hits++;
  return Math.round((hits / wanted.size) * 10_000) / 10_000;
}

/** Answer pairwise (`relevant`) or packed (`p1..pN`) rerank questions from a relevance function; used by fakes only. */
export function answerRerankQuestions(state, questions, relevance = syntheticRelevance) {
  const answers = {};
  for (const id of Object.keys(questions)) {
    const passage = id === 'relevant' ? state?.passage : state?.passages?.[id];
    if (typeof passage !== 'string') throw new Error(`Cannot answer question ${id}: no matching passage in state`);
    answers[id] = { type: 'noul', noul: relevance(state.query, passage) };
  }
  return answers;
}

/** Provider that scores with `relevance` locally; the offline demo and tests use it, never production. */
export function createSyntheticRerankProvider({ relevance = syntheticRelevance, inputTokensPerRequest } = {}) {
  return createFakeProvider(({ state, questions }) => ({
    answers: answerRerankQuestions(state, questions, relevance),
    ...(inputTokensPerRequest === undefined ? {} : { usage: { input_tokens: inputTokensPerRequest, output_tokens: 0 } }),
  }));
}
