import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRerankServer } from '../src/index.mjs';

let providerCalls = 0;
const provider = async () => { providerCalls++; throw new Error('provider must not be called'); };
const server = createRerankServer({ provider, pack: 1, log: () => {} });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v2/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'refund', documents: ['Synthetic policy'], top_n: 1, top_k: 1 }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 400);
  assert.equal(providerCalls, 0);
  const body = await response.json();
  assert.match(body.message, /top_k and top_n/);
  console.log(JSON.stringify({ caseId: 'conflicting_limits', status: response.status, providerCalls }, null, 2));
} finally {
  server.close();
}
