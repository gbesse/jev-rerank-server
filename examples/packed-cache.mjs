import assert from 'node:assert/strict';
import { createScoreCache } from '../src/cache.mjs';
import { rerank } from '../src/rerank.mjs';
let calls = 0;
const provider = async ({ state, questions }) => {
  calls++;
  const packed = Object.hasOwn(state, 'passages');
  const distracted = packed && Object.values(state.passages).includes('distractor');
  return {
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { type: 'noul', noul: packed ? (distracted ? 0.1 : 0.8) : 0.9 },
      ]),
    ),
    usage: { input_tokens: 10, output_tokens: 0 },
  };
};
const cache = createScoreCache();
const pair = await rerank({ query: 'synthetic query', documents: ['target'] }, { provider, cache });
const packed = await rerank(
  { query: 'synthetic query', documents: ['target', 'distractor'] },
  { provider, cache, pack: 2 },
);
const changed = await rerank(
  { query: 'synthetic query', documents: ['target', 'benign'] },
  { provider, cache, pack: 2 },
);
const replay = await rerank(
  { query: 'synthetic query', documents: ['target'] },
  { provider, cache },
);
assert.equal(pair.results[0].relevance_score, 0.9);
assert.equal(packed.results[0].relevance_score, 0.1);
assert.equal(changed.results[0].relevance_score, 0.8);
assert.equal(replay.usage.cached_documents, 1);
assert.equal(calls, 3);
console.log(
  JSON.stringify(
    {
      source: {
        fr: 'Fournisseur synthétique sensible au contexte, aucun appel Jev.',
        en: 'Context-sensitive synthetic provider, no Jev call.',
        es: 'Proveedor sintético sensible al contexto, sin llamadas Jev.',
      },
      pair_score: pair.results[0].relevance_score,
      packed_score: packed.results[0].relevance_score,
      changed_companion_score: changed.results[0].relevance_score,
      pair_replay_cached: replay.usage.cached_documents,
      provider_calls: calls,
    },
    null,
    2,
  ),
);
