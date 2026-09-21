// Purpose: Opt-in live check against api.typesafe.ai: at most 2 paid requests with synthetic input; never run in CI.
import { createJevClient, rerank, estimateCostUsd } from '../src/index.mjs';

if (!process.env.TYPESAFE_API_KEY) {
  console.error('live-smoke: TYPESAFE_API_KEY is not set; no request made. Set it to run this paid check.');
  process.exit(2);
}
// Two documents in pairwise mode = exactly two Jev requests.
const query = 'What is the boiling point of water at sea level?';
const documents = [
  'At sea level, water boils at 100 degrees Celsius.',
  'Water is essential for most known forms of life.',
];
try {
  const provider = createJevClient({ maxRetries: 1 });
  const started = Date.now();
  const response = await rerank({ model: 'jev-1.13.0', query, documents, return_documents: true }, { provider, pack: 1 });
  console.log(JSON.stringify({ query, results: response.results, usage: response.usage, estimated_cost_usd: estimateCostUsd(response.usage.prompt_tokens), elapsed_ms: Date.now() - started }, null, 2));
  if (response.results[0].index !== 0) console.error('live-smoke: note, the factual passage did not rank first; inspect the scores above.');
} catch (error) {
  console.error(`live-smoke: failed: ${error.message}`);
  process.exit(1);
}
