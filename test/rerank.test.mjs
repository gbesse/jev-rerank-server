// Purpose: Unit tests for request normalization, ordering, packing and response shaping without HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRerankRequest, rerank, buildPackedRequest, buildPairwiseRequest, scoreDocuments, createScoreCache, createSyntheticRerankProvider, syntheticRelevance, RELEVANCE_INSTRUCTIONS, RELEVANCE_CRITERIA, RerankValidationError, validatePack } from '../src/index.mjs';

const provider = createSyntheticRerankProvider({ inputTokensPerRequest: 50 });

test('normalization accepts strings, {text} objects, rank_fields objects and free-form objects', () => {
  const normalized = normalizeRerankRequest({
    query: 'q',
    documents: ['plain', { text: 'from text' }, { title: 'T', body: 'B', id: 7 }, { title: 'T2', body: 'B2', extra: 'E' }],
    rank_fields: undefined,
  });
  assert.deepEqual(normalized.documents.map(d => d.text), ['plain', 'from text', 'title: T\nbody: B', 'title: T2\nbody: B2\nextra: E']);
  assert.equal(normalized.model, 'jev-1.13.0');
  assert.equal(normalized.shape, 'cohere');
  assert.equal(normalized.limit, null);
  const withFields = normalizeRerankRequest({ query: 'q', documents: [{ title: 'T', body: 'B', extra: 'E' }], rank_fields: ['body', 'title'] });
  assert.equal(withFields.documents[0].text, 'body: B\ntitle: T');
});

test('normalization rejects protocol violations with 400-class errors', () => {
  const cases = [
    [{ query: 'q' }, /documents must be an array/],
    [{ query: 'q', documents: [1] }, /must be a string or an object/],
    [{ query: 'q', documents: [{ n: 1 }] }, /no text field/],
    [{ query: 'q', documents: ['a'], top_n: 0 }, /top_n must be a positive integer/],
    [{ query: 'q', documents: ['a'], top_k: 1.5 }, /top_k must be a positive integer/],
    [{ query: 'q', documents: ['a'], top_k: 1, top_n: 1 }, /top_k and top_n cannot be combined/],
    [{ query: 'x'.repeat(4001), documents: ['a'] }, /query exceeds 4000/],
    [{ query: 'q', documents: ['a'], return_documents: 'yes' }, /return_documents must be a boolean/],
    [{ query: 'q', documents: ['a'], rank_fields: [] }, /rank_fields/],
    [{ query: 'q', documents: [{ a: 'b' }], rank_fields: ['missing'] }, /none of the rank_fields/],
    [{ query: 'q', documents: ['a'], model: 3 }, /model must be a string/],
    [[], /JSON object/],
  ];
  for (const [body, pattern] of cases) assert.throws(() => normalizeRerankRequest(body), error => error instanceof RerankValidationError && pattern.test(error.message));
});

test('pairwise request wording matches the cookbook and packed requests name each passage', () => {
  assert.deepEqual(buildPairwiseRequest('q', 'p'), { state: { query: 'q', passage: 'p' }, questions: { relevant: { type: 'noul', instructions: RELEVANCE_INSTRUCTIONS, criteria: RELEVANCE_CRITERIA } } });
  const packed = buildPackedRequest('q', ['a', 'b']);
  assert.deepEqual(packed.state, { query: 'q', passages: { p1: 'a', p2: 'b' } });
  assert.deepEqual(Object.keys(packed.questions), ['p1', 'p2']);
  assert.match(packed.questions.p1.criteria.true, /Passage p1/);
  assert.throws(() => validatePack(21), /between 1 and 20/);
  assert.throws(() => validatePack(0), RangeError);
});

test('rerank sorts by score, keeps original indices, applies top_n and returns documents on request', async () => {
  const body = { query: 'capital of France', documents: ['nothing here', 'Paris is the capital of France', { text: 'France is a country' }], top_n: 2, return_documents: true };
  const result = await rerank(body, { provider });
  assert.deepEqual(result.results.map(r => r.index), [1, 2]);
  assert.deepEqual(result.results[0].document, { text: 'Paris is the capital of France' });
  assert.deepEqual(result.results[1].document, { text: 'France is a country' });
  assert.equal(result.usage.jev_requests, 3);
  assert.equal(result.usage.prompt_tokens, 150);
});

test('identical rendered documents are scored once while every original index is preserved', async () => {
  let calls = 0;
  const counting = async request => { calls++; return provider(request); };
  const result = await rerank({
    query: 'capital of France',
    documents: ['Paris is the capital of France', 'nothing here', 'Paris is the capital of France'],
    return_documents: true,
  }, { provider: counting });
  assert.equal(calls, 2);
  assert.deepEqual(result.results.map(item => item.index), [0, 2, 1]);
  assert.equal(result.results[0].relevance_score, result.results[1].relevance_score);
  assert.equal(result.usage.jev_requests, 2);
  assert.equal(result.usage.unique_documents, 2);
  assert.equal(result.usage.deduplicated_documents, 1);
  assert.equal(result.usage.prompt_tokens, 100);
});

test('deduplication composes with packed mode', async () => {
  let calls = 0;
  const counting = async request => { calls++; return provider(request); };
  const result = await rerank({ query: 'red', documents: ['red', 'blue', 'red', 'green'] }, { provider: counting, pack: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(result.results.map(item => item.index), [0, 2, 1, 3]);
  assert.equal(result.usage.unique_documents, 3);
  assert.equal(result.usage.deduplicated_documents, 1);
});

test('exact score cache avoids repeated provider calls, expires and evicts least-recently-used entries', async () => {
  let clock = 1000, calls = 0;
  const cache = createScoreCache({ ttlMs: 100, maxEntries: 2, now: () => clock });
  const counting = async request => { calls++; return provider(request); };
  const body = { query: 'capital of France', documents: ['Paris is the capital of France', 'nothing here'] };
  const first = await rerank(body, { provider: counting, cache });
  const second = await rerank(body, { provider: counting, cache });
  assert.equal(calls, 2);
  assert.deepEqual(second.results, first.results.map(({ index, relevance_score }) => ({ index, relevance_score })));
  assert.equal(second.usage.jev_requests, 0);
  assert.equal(second.usage.cached_documents, 2);
  assert.equal(second.usage.scored_documents, 0);
  assert.equal(second.usage.total_tokens, 0);
  cache.get(body.query, body.documents[0]); // Paris is now most recently used.
  cache.set('q2', 'd2', 0.2); // Evicts "nothing here".
  assert.equal(cache.get(body.query, body.documents[1]), undefined);
  clock += 101;
  assert.equal(cache.get(body.query, body.documents[0]), undefined);
  assert.throws(() => createScoreCache({ ttlMs: 0 }), /ttlMs/);
});

test('failed multi-group requests do not warm the shared score cache', async () => {
  const cache = createScoreCache();
  const failing = async request => {
    if (request.state.passage === 'boom') throw new Error('provider exploded');
    return provider(request);
  };
  await assert.rejects(rerank({ query: 'q', documents: ['safe', 'boom'] }, { provider: failing, cache }), /provider exploded/);
  assert.equal(cache.size, 0);
});

test('object documents are returned as the original object in the Cohere shape', async () => {
  const result = await rerank({ query: 'red', documents: [{ title: 'red shoes', sku: 'A' }], return_documents: true }, { provider });
  assert.deepEqual(result.results[0].document, { title: 'red shoes', sku: 'A' });
});

test('empty document lists return an empty result without provider calls', async () => {
  let calls = 0;
  const counting = async request => { calls++; return provider(request); };
  const result = await rerank({ query: 'q', documents: [], top_k: 3 }, { provider: counting });
  assert.deepEqual(result.data, []);
  assert.equal(result.usage.total_tokens, 0);
  assert.equal(calls, 0);
});

test('a failing request aborts the siblings and rejects without partial scores', async () => {
  const seen = [];
  const failing = async ({ state, signal }) => {
    if (state.passage === 'boom') throw new Error('provider exploded');
    await new Promise(resolve => setTimeout(resolve, 20));
    seen.push(signal.aborted);
    return provider({ state, questions: { relevant: { type: 'noul', instructions: 'x' } } });
  };
  await assert.rejects(scoreDocuments({ provider: failing, query: 'q', texts: ['a', 'boom', 'c'] }), /provider exploded/);
  assert.ok(seen.every(Boolean), 'sibling requests observed the abort');
});

test('synthetic relevance is deterministic and bounded', () => {
  assert.equal(syntheticRelevance('capital of France', 'Paris is the capital of France'), 1);
  assert.equal(syntheticRelevance('capital of France', 'Tokyo'), 0);
  assert.equal(syntheticRelevance('', 'anything'), 0);
});
