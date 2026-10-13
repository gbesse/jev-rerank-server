import test from 'node:test';
import assert from 'node:assert/strict';
import { createScoreCache } from '../src/cache.mjs';
import { rerank } from '../src/rerank.mjs';

function contextProvider() {
  let calls = 0;
  const provider = async ({ state, questions }) => {
    calls++;
    const packed = Object.hasOwn(state, 'passages');
    const distractor = packed && Object.values(state.passages).includes('distractor');
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [
        key,
        { type: 'noul', noul: packed ? (distractor ? 0.1 : 0.8) : 0.9 },
      ]),
    );
    return { answers, usage: { input_tokens: 10, output_tokens: 0 } };
  };
  return {
    provider,
    get calls() {
      return calls;
    },
  };
}
test('packed scores cannot reuse or poison a pairwise score cache', async () => {
  const cache = createScoreCache(),
    model = contextProvider();
  const pair = await rerank(
    { query: 'same query', documents: ['target'] },
    { provider: model.provider, cache },
  );
  assert.equal(pair.results[0].relevance_score, 0.9);
  const packed = await rerank(
    { query: 'same query', documents: ['target', 'distractor'] },
    { provider: model.provider, pack: 2, cache },
  );
  assert.equal(packed.results.find((x) => x.index === 0).relevance_score, 0.1);
  assert.equal(packed.usage.cached_documents, 0);
  assert.equal(cache.size, 1);
  assert.ok(packed.meta.warnings[0].includes('FR :'));
  assert.ok(packed.meta.warnings[0].includes('EN:'));
  assert.ok(packed.meta.warnings[0].includes('ES:'));
  const repeatedPair = await rerank(
    { query: 'same query', documents: ['target'] },
    { provider: model.provider, cache },
  );
  assert.equal(repeatedPair.results[0].relevance_score, 0.9);
  assert.equal(repeatedPair.usage.cached_documents, 1);
  assert.equal(model.calls, 2);
});
test('changing companion passages changes the packed score despite an enabled pair cache', async () => {
  const cache = createScoreCache(),
    model = contextProvider();
  const a = await rerank(
    { query: 'same query', documents: ['target', 'distractor'], top_k: 2 },
    { provider: model.provider, pack: 2, cache },
  );
  const b = await rerank(
    { query: 'same query', documents: ['target', 'benign'], top_k: 2 },
    { provider: model.provider, pack: 2, cache },
  );
  assert.equal(a.data[0].relevance_score, 0.1);
  assert.equal(b.data[0].relevance_score, 0.8);
  assert.equal(b.usage.cached_documents, 0);
  assert.equal(cache.size, 0);
  assert.equal(model.calls, 2);
  assert.ok(b.warnings[0].includes('packed mode'));
});
test('duplicate document indices remain present in packed mode', async () => {
  const cache = createScoreCache(),
    model = contextProvider();
  const result = await rerank(
    { query: 'same query', documents: ['target', 'target', 'distractor'] },
    { provider: model.provider, pack: 2, cache },
  );
  assert.deepEqual(
    result.results.map((x) => x.index),
    [0, 1, 2],
  );
  assert.equal(result.usage.deduplicated_documents, 1);
  assert.equal(result.usage.cached_documents, 0);
});
