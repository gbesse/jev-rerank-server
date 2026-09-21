// Purpose: Loopback HTTP double of the Jev endpoint for protocol tests: records requests, scripts failures and delays.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { answerRerankQuestions, syntheticRelevance } from '../src/rerank.mjs';

/**
 * `statusQueue` lists statuses to return before answering normally (e.g. `[529]` then success).
 * `inputTokensPerRequest` makes cost math predictable. Answers come from `relevance`, a synthetic function.
 */
export async function startFakeJev({ relevance = syntheticRelevance, statusQueue = [], delayMs = 0, inputTokensPerRequest = 100, model = 'jev-1.13.0' } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ headers: request.headers, body });
    if (delayMs) await delay(delayMs);
    const status = statusQueue.shift();
    if (status) {
      response.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '0' } : {}) });
      response.end(JSON.stringify({ message: `fake jev ${status}` }));
      return;
    }
    const answers = answerRerankQuestions(body.state, body.questions, relevance);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model, answers, usage: { input_tokens: inputTokensPerRequest, output_tokens: 0 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Start the rerank server on an ephemeral loopback port. */
export async function startServer(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function postJson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
