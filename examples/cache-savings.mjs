// Purpose: Compare duplicate-document deduplication and exact cross-request caching offline.
import { createScoreCache, createSyntheticRerankProvider, rerank } from '../src/index.mjs';

const provider = createSyntheticRerankProvider({ inputTokensPerRequest: 120 });
const cache = createScoreCache({ ttlMs: 300_000, maxEntries: 20 });
const documents = [
  'Unworn shoes can be returned within 30 days of delivery.',
  'Shipping is free for orders above 80 euros.',
  'Unworn shoes can be returned within 30 days of delivery.',
];
const firstQuery = 'How long can I return unworn shoes?';
const scenarios = [
  ['first request', firstQuery],
  ['same request again', firstQuery],
  ['changed query', 'When is shipping free?'],
];

console.log('Synthetic relevance on fictional documents; no Jev API call.');
for (const [label, query] of scenarios) {
  const response = await rerank({ query, documents, top_n: 2 }, { provider, cache });
  const { jev_requests, unique_documents, deduplicated_documents, cached_documents } = response.usage;
  console.log(`${label}: requests=${jev_requests}, unique_documents=${unique_documents}, deduplicated=${deduplicated_documents}, cached=${cached_documents}, top_index=${response.results[0].index}`);
}
