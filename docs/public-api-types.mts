// Purpose: Compile-check representative public API usage, without running code or calling Jev.
import { createJevClient, createFakeProvider, createSyntheticRerankProvider, createRerankServer, createLimiter, rerank, normalizeRerankRequest, estimateCostUsd, JEV_MODEL, type RerankRequestBody, type RerankResponse, type JevProvider } from '../src/index.mjs';

const live: JevProvider = createJevClient({ apiKey: 'typecheck-only', timeoutMs: 10_000 });
const fake: JevProvider = createFakeProvider({ answers: { relevant: { type: 'noul', noul: 0.5 } } });
const synthetic: JevProvider = createSyntheticRerankProvider({ inputTokensPerRequest: 10 });
const body: RerankRequestBody = { model: JEV_MODEL, query: 'q', documents: ['a', { text: 'b' }, { title: 'c', body: 'd' }], top_n: 2, return_documents: true };
const response: RerankResponse = await rerank(body, { provider: synthetic, pack: 2, limiter: createLimiter({ concurrency: 2 }) });
if ('results' in response) response.results[0]?.relevance_score.toFixed(3);
else response.data[0]?.index.toFixed(0);
const cost: number = estimateCostUsd(response.usage.total_tokens);
normalizeRerankRequest(body).documents[0]?.truncated;
const server = createRerankServer({ provider: live, token: 'shared', pack: 1 });
server.listen(0, '127.0.0.1');
server.close();
void fake; void cost;
// @ts-expect-error A provider is required.
createRerankServer({ token: 'shared' });
// @ts-expect-error Pack must be a number.
rerank(body, { provider: synthetic, pack: '3' });
