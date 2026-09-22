// Purpose: Run real Python framework wrappers against the production HTTP handler with synthetic scoring.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRerankServer, createSyntheticRerankProvider } from '../src/index.mjs';

const server = createRerankServer({
  provider: createSyntheticRerankProvider(), token: 'integration-test-token', log: () => {},
});
const requests = [];
server.on('request', (request, response) => {
  response.on('finish', () => requests.push({ method: request.method, path: request.url, status: response.statusCode }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let child;
let timeout;
try {
  child = spawn(process.env.PYTHON ?? 'python3', ['integrations/framework_compatibility.py'], {
    stdio: 'inherit',
    env: { ...process.env, JEV_RERANK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
  });
  timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 0, `Framework tests failed (signal: ${signal})`);
  // Empty collections are short-circuited by the wrappers: 13 tests, 11 HTTP calls.
  assert.equal(requests.length, 11);
  assert.ok(requests.every(({ method, path }) => method === 'POST' && path === '/v2/rerank'));
  assert.equal(requests.filter(r => r.status === 200).length, 7);
  assert.equal(requests.filter(r => r.status === 401).length, 2);
  assert.equal(requests.filter(r => r.status === 400).length, 2);
  console.log('HTTP verified: 11 POST /v2/rerank calls (7 × 200, 2 × 401, 2 × 400).');
  console.log('Scope: protocol compatibility only; synthetic scores, no live Jev quality or latency claim.');
} finally {
  clearTimeout(timeout);
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
