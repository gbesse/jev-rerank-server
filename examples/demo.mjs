// Purpose: Offline demonstration: start the server on loopback with a synthetic provider and send Cohere-, Jina- and Voyage-shaped requests.
import { once } from 'node:events';
import { createRerankServer, createSyntheticRerankProvider } from '../src/index.mjs';

// Synthetic relevance = share of query words present in the passage. These numbers are not Jev output.
const provider = createSyntheticRerankProvider({ inputTokensPerRequest: 120 });
const server = createRerankServer({ provider, pack: 1 });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;

const documents = [
  'The return window for unworn shoes is 30 days from delivery.',
  'Our shoes are made in Portugal from vegetable-tanned leather.',
  'Refunds are issued to the original payment method within 5 business days of receiving the return.',
  'Shipping is free on orders above 80 euros.',
];
const query = 'How long do I have to return shoes?';

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${json.message}`);
  return json;
}

try {
  console.log('source: synthetic provider on loopback, no API call, scores are not Jev output\n');
  const cohere = await post('/v2/rerank', { model: 'rerank-v3.5', query, documents, top_n: 2, return_documents: true });
  console.log('Cohere v2 shape (top_n=2):');
  console.log(JSON.stringify({ model: cohere.model, served_by: cohere.served_by, results: cohere.results, usage: cohere.usage }, null, 2));
  const jina = await post('/v1/rerank', { model: 'jina-reranker-v2-base-multilingual', query, documents: documents.map(text => ({ text })) });
  console.log('\nJina shape ({text} documents): order', jina.results.map(r => `${r.index}:${r.relevance_score}`).join(' '));
  const voyage = await post('/v1/rerank', { model: 'rerank-2', query, documents, top_k: 1 });
  console.log('\nVoyage shape (top_k=1):');
  console.log(JSON.stringify(voyage, null, 2));
} finally {
  server.close();
}
