// Purpose: Host the synthetic rerank service and run the real Cohere Python v2 SDK against it without a paid API call.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRerankServer, createSyntheticRerankProvider } from '../src/index.mjs';

const python = process.env.PYTHON ?? 'python3';
const server = createRerankServer({ provider: createSyntheticRerankProvider(), token: 'integration-test-token' });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address();
const child = spawn(python, ['integrations/cohere_v2_smoke.py'], {
  stdio: 'inherit',
  env: { ...process.env, JEV_RERANK_BASE_URL: `http://127.0.0.1:${port}` },
});
const [code] = await once(child, 'exit');
await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
if (code !== 0) process.exitCode = code ?? 1;
