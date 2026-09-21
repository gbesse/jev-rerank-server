// Purpose: End-to-end protocol tests through the HTTP server against a fake Jev on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevClient, createRerankServer, createLimiter, INPUT_USD_PER_MILLION_TOKENS } from '../src/index.mjs';
import { startFakeJev, startServer, postJson } from './fake-jev.mjs';

const KEY = 'sk-test-secret-never-leaked';
const docs = ['Paris is the capital of France.', 'The Loire is a river in France.', 'Tokyo is the capital of Japan.'];
const query = 'What is the capital of France?';

async function setup({ jev = {}, server = {}, client = {} } = {}) {
  const fake = await startFakeJev(jev);
  const provider = createJevClient({ apiKey: KEY, endpoint: fake.url, retryBaseMs: 1, ...client });
  const app = await startServer(createRerankServer({ provider, log: () => {}, ...server }));
  return { fake, app, close: async () => { await app.close(); await fake.close(); } };
}

test('Cohere v2 request with string documents returns the Cohere envelope sorted by score', async () => {
  const { fake, app, close } = await setup();
  try {
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { model: 'rerank-v3.5', query, documents: docs, top_n: 2 });
    assert.equal(status, 200);
    assert.equal(body.model, 'rerank-v3.5');
    assert.equal(body.served_by, 'jev-1.13.0');
    assert.equal(typeof body.id, 'string');
    assert.deepEqual(body.results.map(r => r.index), [0, 1]);
    assert.ok(body.results[0].relevance_score >= body.results[1].relevance_score);
    assert.equal(body.results[0].document, undefined);
    assert.deepEqual(body.meta, { api_version: { version: '2' }, billed_units: { search_units: 1 } });
    assert.equal(fake.requests.length, 3);
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(fake.requests[0].body.questions), ['relevant']);
    assert.deepEqual(Object.keys(fake.requests[0].body.state), ['query', 'passage']);
  } finally { await close(); }
});

test('Jina request with {text} objects and return_documents echoes documents', async () => {
  const { app, close } = await setup();
  try {
    const { status, body } = await postJson(`${app.url}/v1/rerank`, { model: 'jina-reranker-v2-base-multilingual', query, documents: docs.map(text => ({ text })), return_documents: true });
    assert.equal(status, 200);
    assert.equal(body.results.length, 3);
    assert.deepEqual(body.results[0], { index: 0, relevance_score: body.results[0].relevance_score, document: { text: docs[0] } });
  } finally { await close(); }
});

test('Voyage request with top_k returns the data envelope with bare document strings', async () => {
  const { app, close } = await setup();
  try {
    const { status, body } = await postJson(`${app.url}/v1/rerank`, { model: 'rerank-2', query, documents: docs, top_k: 1, return_documents: true });
    assert.equal(status, 200);
    assert.equal(body.object, 'list');
    assert.equal(body.results, undefined);
    assert.deepEqual(body.data, [{ index: 0, relevance_score: body.data[0].relevance_score, document: docs[0] }]);
    assert.equal(body.usage.total_tokens, 300);
  } finally { await close(); }
});

test('ties are broken by original index and scores are descending', async () => {
  const { app, close } = await setup({ jev: { relevance: (_, passage) => (passage.startsWith('B') ? 0.9 : 0.5) } });
  try {
    const { body } = await postJson(`${app.url}/v2/rerank`, { query, documents: ['A1', 'B1', 'A2', 'B2', 'A3'] });
    assert.deepEqual(body.results.map(r => [r.index, r.relevance_score]), [[1, 0.9], [3, 0.9], [0, 0.5], [2, 0.5], [4, 0.5]]);
  } finally { await close(); }
});

test('documents over 20000 characters are truncated and flagged rather than rejected', async () => {
  const { fake, app, close } = await setup();
  try {
    const long = 'x'.repeat(25_000);
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { query, documents: [long, 'short'] });
    assert.equal(status, 200);
    const flagged = body.results.find(r => r.index === 0);
    assert.equal(flagged.truncated, true);
    assert.equal(body.results.find(r => r.index === 1).truncated, undefined);
    const sent = fake.requests.map(r => r.body.state.passage).find(p => p.startsWith('x'));
    assert.equal(sent.length, 20_000);
  } finally { await close(); }
});

test('1001 documents, missing query, bad JSON and unknown routes are client errors without Jev calls', async () => {
  const { fake, app, close } = await setup();
  try {
    let res = await postJson(`${app.url}/v2/rerank`, { query, documents: Array.from({ length: 1001 }, (_, i) => `d${i}`) });
    assert.equal(res.status, 400); assert.match(res.body.message, /maximum of 1000/);
    res = await postJson(`${app.url}/v2/rerank`, { documents: docs });
    assert.equal(res.status, 400); assert.match(res.body.message, /query is required/);
    res = await postJson(`${app.url}/v2/rerank`, '{not json');
    assert.equal(res.status, 400);
    res = await postJson(`${app.url}/v2/rerank`, { query, documents: docs, max_chunks_per_doc: 3 });
    assert.equal(res.status, 200); assert.match(res.body.meta.warnings[0], /max_chunks_per_doc is ignored/);
    const missing = await fetch(`${app.url}/nope`, { signal: AbortSignal.timeout(5000) });
    assert.equal(missing.status, 404);
    const wrongMethod = await fetch(`${app.url}/v1/rerank`, { signal: AbortSignal.timeout(5000) });
    assert.equal(wrongMethod.status, 405);
    assert.equal(fake.requests.length, 3);
  } finally { await close(); }
});

test('server token is enforced on rerank routes and not on probes', async () => {
  const { fake, app, close } = await setup({ server: { token: 'client-token' } });
  try {
    let res = await postJson(`${app.url}/v2/rerank`, { query, documents: docs });
    assert.equal(res.status, 401); assert.deepEqual(res.body, { message: 'Missing or invalid bearer token' });
    res = await postJson(`${app.url}/v2/rerank`, { query, documents: docs }, { authorization: 'Bearer wrong-token' });
    assert.equal(res.status, 401);
    assert.equal(fake.requests.length, 0);
    res = await postJson(`${app.url}/v2/rerank`, { query, documents: docs }, { authorization: 'Bearer client-token' });
    assert.equal(res.status, 200);
    res = await postJson(`${app.url}/v2/rerank`, { query, documents: docs }, { 'x-api-key': 'client-token' });
    assert.equal(res.status, 200);
    const health = await fetch(`${app.url}/healthz`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, model: 'jev-1.13.0', pack: 1 });
  } finally { await close(); }
});

test('Jev 529 then success is retried transparently', async () => {
  const { fake, app, close } = await setup({ jev: { statusQueue: [529] } });
  try {
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { query, documents: [docs[0]] });
    assert.equal(status, 200);
    assert.equal(body.results.length, 1);
    assert.equal(fake.requests.length, 2);
  } finally { await close(); }
});

test('Jev 500 becomes a 502 with no partial result and no key in the message', async () => {
  const { app, close } = await setup({ jev: { statusQueue: [500] }, client: { maxRetries: 0 } });
  try {
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { query, documents: docs });
    assert.equal(status, 502);
    assert.deepEqual(Object.keys(body), ['message']);
    assert.match(body.message, /Jev request failed: Jev HTTP 500/);
    assert.ok(!body.message.includes(KEY));
  } finally { await close(); }
});

test('Jev slower than the client timeout becomes a 504', async () => {
  const { app, close } = await setup({ jev: { delayMs: 300 }, client: { timeoutMs: 50, maxRetries: 0 } });
  try {
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { query, documents: [docs[0]] });
    assert.equal(status, 504);
    assert.match(body.message, /timed out/);
  } finally { await close(); }
});

test('packed mode groups 7 documents into 3 requests with N=3', async () => {
  const { fake, app, close } = await setup({ server: { pack: 3 } });
  try {
    const seven = ['France capital Paris', 'b', 'c', 'd', 'e', 'f', 'g'];
    const { status, body } = await postJson(`${app.url}/v2/rerank`, { query, documents: seven });
    assert.equal(status, 200);
    assert.equal(fake.requests.length, 3);
    const sizes = fake.requests.map(r => Object.keys(r.body.state.passages).length).sort();
    assert.deepEqual(sizes, [1, 3, 3]);
    const packed = fake.requests.find(r => r.body.state.passages.p3);
    assert.deepEqual(Object.keys(packed.body.questions), ['p1', 'p2', 'p3']);
    assert.match(packed.body.questions.p2.instructions, /passage p2/);
    assert.equal(body.results.length, 7);
    assert.equal(body.results[0].index, 0);
    assert.equal(body.usage.jev_requests, 3);
    const health = await (await fetch(`${app.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(health.pack, 3);
  } finally { await close(); }
});

test('usage aggregates Jev input tokens and the estimated cost follows the price list', async () => {
  const { app, close } = await setup({ jev: { inputTokensPerRequest: 100 } });
  try {
    const { body } = await postJson(`${app.url}/v2/rerank`, { query, documents: docs });
    assert.deepEqual(body.usage, { total_tokens: 300, prompt_tokens: 300, jev_requests: 3, estimated_cost_usd: 0.0000126 });
    assert.equal(INPUT_USD_PER_MILLION_TOKENS, 0.042);
  } finally { await close(); }
});

test('/v1/models lists the pinned model and aliases', async () => {
  const { app, close } = await setup();
  try {
    const body = await (await fetch(`${app.url}/v1/models`, { signal: AbortSignal.timeout(5000) })).json();
    assert.equal(body.data[0].id, 'jev-1.13.0');
    assert.ok(body.data.some(m => m.id === 'jev-latest'));
    assert.ok(body.data.every(m => m.served_by === 'jev-1.13.0'));
  } finally { await close(); }
});

test('the limiter bounds concurrent Jev requests', async () => {
  let active = 0, peak = 0;
  const fake = await startFakeJev();
  const provider = createJevClient({ apiKey: KEY, endpoint: fake.url });
  const counting = async request => { active++; peak = Math.max(peak, active); try { return await provider(request); } finally { active--; } };
  const app = await startServer(createRerankServer({ provider: counting, limiter: createLimiter({ concurrency: 2 }), log: () => {} }));
  try {
    const { status } = await postJson(`${app.url}/v2/rerank`, { query, documents: Array.from({ length: 9 }, (_, i) => `doc ${i}`) });
    assert.equal(status, 200);
    assert.equal(peak, 2);
  } finally { await app.close(); await fake.close(); }
});
