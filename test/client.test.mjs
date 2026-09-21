// Purpose: Jev client contract tests: option validation, strict response validation, retries, redaction, limiter and CLI parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createJevClient, createFakeProvider, validateResponse, estimateTokens, estimateCostUsd, createLimiter, JevError } from '../src/index.mjs';
import { parseArgs } from '../bin/jev-rerank-server.mjs';
import { startFakeJev } from './fake-jev.mjs';

const run = promisify(execFile);
const noul = { relevant: { type: 'noul', instructions: 'x' } };
const choice = { pick: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } } };
const score = { level: { type: 'score', instructions: 'x', criteria: ['low', 'mid', 'high'] } };
const usage = { input_tokens: 10, output_tokens: 0 };
const ok = answers => ({ model: 'jev-1.13.0', answers, usage });

test('client refuses missing keys, aliases and non-loopback HTTP endpoints', () => {
  assert.throws(() => createJevClient({ apiKey: '' }), /Set TYPESAFE_API_KEY/);
  assert.throws(() => createJevClient({ apiKey: 'k', model: 'jev-latest' }), /Pin an explicit model/);
  assert.throws(() => createJevClient({ apiKey: 'k', endpoint: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => createJevClient({ apiKey: 'k', endpoint: 'https://user:pw@example.com/v1' }), /credentials/);
  assert.doesNotThrow(() => createJevClient({ apiKey: 'k', endpoint: 'http://localhost:1/v1' }));
});

test('response validation rejects every deviation from the declared contract', () => {
  assert.deepEqual(validateResponse(ok({ relevant: { type: 'noul', noul: 0.4 } }), { model: 'jev-1.13.0', questions: noul }).answers.relevant.noul, 0.4);
  const bad = [
    [ok({ relevant: { type: 'noul', noul: 0.4 } }), noul, 'jev-1.12.0', /model mismatch/],
    [ok({}), noul, 'jev-1.13.0', /answer relevant missing/],
    [ok({ relevant: { type: 'noul', noul: 1.2 } }), noul, 'jev-1.13.0', /in \[0,1\]/],
    [ok({ relevant: { type: 'noul', noul: 0.2 }, extra: { type: 'noul', noul: 0.1 } }), noul, 'jev-1.13.0', /unexpected answers extra/],
    [ok({ relevant: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 } }), noul, 'jev-1.13.0', /has type choice/],
    [ok({ pick: { type: 'choice', choice: 'z', probabilities: { a: 1 }, confidence: 1 } }), choice, 'jev-1.13.0', /choice z is not one of/],
    [ok({ pick: { type: 'choice', choice: 'a', probabilities: { q: 1 }, confidence: 1 } }), choice, 'jev-1.13.0', /unknown option q/],
    [ok({ pick: { type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 2 } }), choice, 'jev-1.13.0', /confidence/],
    [ok({ level: { type: 'score', score: 3, probabilities: { 0: 1 }, confidence: 1 } }), score, 'jev-1.13.0', /score out of range/],
    [{ model: 'jev-1.13.0', answers: { relevant: { type: 'noul', noul: 0.5 } } }, noul, 'jev-1.13.0', /usage.input_tokens/],
  ];
  for (const [response, questions, model, pattern] of bad) assert.throws(() => validateResponse(response, { model, questions }), error => error instanceof JevError && pattern.test(error.message));
  const valid = validateResponse(ok({ level: { type: 'score', score: 1.5, probabilities: { 1: 0.5, 2: 0.5 }, confidence: 0.5 } }), { model: 'jev-1.13.0', questions: score });
  assert.equal(valid.answers.level.score, 1.5);
});

test('token estimate and cost estimate follow the documented formulas', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens({ a: 'b' }), Math.ceil('{"a":"b"}'.length / 4));
  assert.equal(estimateCostUsd(1_000_000), 0.042);
  assert.equal(estimateCostUsd(0), 0);
});

test('client refuses states over the token budget before any network call', async () => {
  let called = false;
  const client = createJevClient({ apiKey: 'k', stateTokenBudget: 10, fetchImpl: async () => { called = true; } });
  await assert.rejects(client({ state: { passage: 'x'.repeat(100) }, questions: noul }), /exceeds the budget of 10/);
  assert.equal(called, false);
});

test('client retries 429 with retry-after and network errors, never 422, and redacts the key', async () => {
  const fake = await startFakeJev({ statusQueue: [429, 529] });
  try {
    const client = createJevClient({ apiKey: 'sk-secret', endpoint: fake.url, retryBaseMs: 1 });
    const response = await client({ state: { query: 'q', passage: 'p' }, questions: noul });
    assert.equal(response.model, 'jev-1.13.0');
    assert.equal(fake.requests.length, 3);
  } finally { await fake.close(); }

  const attempts = [];
  const flaky = createJevClient({ apiKey: 'sk-secret', maxRetries: 1, retryBaseMs: 1, fetchImpl: async () => { attempts.push(1); throw new TypeError('fetch failed sk-secret'); } });
  await assert.rejects(flaky({ state: 's', questions: noul }), error => error.code === 'network' && !error.message.includes('sk-secret') && error.message.includes('[redacted]'));
  assert.equal(attempts.length, 2);

  const noRetry = createJevClient({ apiKey: 'sk-secret', fetchImpl: async () => { attempts.push(2); return new Response('{"message":"bad sk-secret"}', { status: 422 }); } });
  await assert.rejects(noRetry({ state: 's', questions: noul }), error => error.status === 422 && !error.message.includes('sk-secret'));
  assert.equal(attempts.filter(a => a === 2).length, 1);

  const exhausted = createJevClient({ apiKey: 'sk-secret', maxRetries: 1, retryBaseMs: 1, fetchImpl: async () => new Response('', { status: 529 }) });
  await assert.rejects(exhausted({ state: 's', questions: noul }), error => error.status === 529 && error.code === 'overloaded');
});

test('client honours caller aborts without retrying', async () => {
  const controller = new AbortController();
  const client = createJevClient({ apiKey: 'k', maxRetries: 3, fetchImpl: async (_, { signal }) => { controller.abort(new Error('caller cancelled')); signal.throwIfAborted(); } });
  await assert.rejects(client({ state: 's', questions: noul, signal: controller.signal }), /caller cancelled/);
});

test('fake provider validates fixtures like a real response', async () => {
  const good = createFakeProvider({ answers: { relevant: { type: 'noul', noul: 0.7 } } });
  const response = await good({ state: { a: 1 }, questions: noul });
  assert.equal(response.answers.relevant.noul, 0.7);
  assert.equal(response.usage.input_tokens, estimateTokens({ state: { a: 1 }, questions: noul }));
  const bad = createFakeProvider(() => ({ relevant: { type: 'noul', noul: 'high' } }));
  await assert.rejects(bad({ state: {}, questions: noul }), /in \[0,1\]/);
  assert.throws(() => createFakeProvider('nope'), /function or an object/);
});

test('limiter enforces the sliding-window rate with an injected clock', async () => {
  let clock = 0;
  const sleeps = [];
  const limiter = createLimiter({ concurrency: 4, requestsPerMinute: 2, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  await Promise.all([limiter.run(async () => 1), limiter.run(async () => 2), limiter.run(async () => 3)]);
  assert.deepEqual(sleeps, [60_000]);
  await assert.rejects(limiter.run(async () => { throw new Error('inner'); }), /inner/);
  assert.equal(limiter.active, 0);
  assert.throws(() => createLimiter({ concurrency: 0 }), RangeError);
});

test('CLI parses flags and environment, prints help, and refuses to serve without a key', async () => {
  assert.deepEqual(parseArgs(['--port', '9000', '--pack', '4', '--token', 't'], {}), { port: 9000, host: '127.0.0.1', pack: 4, token: 't', help: false });
  assert.equal(parseArgs([], { JEV_RERANK_PACK: '2', RERANK_SERVER_TOKEN: 'env' }).pack, 2);
  assert.throws(() => parseArgs(['--pack', '99'], {}), /--pack must be/);
  assert.throws(() => parseArgs(['--bogus'], {}), /Unknown argument/);
  const bin = new URL('../bin/jev-rerank-server.mjs', import.meta.url).pathname;
  const help = await run(process.execPath, [bin, '--help'], { env: { ...process.env, TYPESAFE_API_KEY: '' } });
  assert.match(help.stdout, /jev-rerank-server \[--port/);
  await assert.rejects(run(process.execPath, [bin], { env: { ...process.env, TYPESAFE_API_KEY: '' } }), error => error.code === 1 && /Set TYPESAFE_API_KEY/.test(error.stderr));
});
