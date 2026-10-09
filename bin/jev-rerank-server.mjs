#!/usr/bin/env node
// Purpose: CLI that serves the rerank API with the real Jev client; configuration from flags and environment.
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createJevClient } from '../src/jev-client.mjs';
import { createRerankServer } from '../src/server.mjs';
import { createLimiter } from '../src/concurrency.mjs';
import { createScoreCache } from '../src/cache.mjs';
import { LIMITS } from '../src/rerank.mjs';

const USAGE = `jev-rerank-server [--port 8787] [--host 127.0.0.1] [--pack N] [--token TOKEN] [--cache-ttl SECONDS]

Environment:
  TYPESAFE_API_KEY      required; requests are paid and go to api.typesafe.ai
  RERANK_SERVER_TOKEN   optional bearer token clients must send (same as --token)
  JEV_RERANK_PACK       passages per Jev request, 1 (pairwise, default) to ${LIMITS.maxPack}
  JEV_ENDPOINT          override the Jev endpoint (HTTPS, or loopback HTTP for tests)
  JEV_PROVIDER          jev (default) or clef (Cloudflare Workers AI)
  JEV_MODEL             clef or clef-flash when JEV_PROVIDER=clef
  CLOUDFLARE_ACCOUNT_ID 32-character account ID for Clef
  CLOUDFLARE_AUTH_TOKEN API token for Clef; TYPESAFE_API_KEY remains for Jev
  JEV_CONCURRENCY       parallel Jev requests (default 8)
  JEV_REQUESTS_PER_MINUTE  local rate cap (default 1000)
  JEV_CACHE_TTL_SECONDS exact-score cache lifetime; 0 disables it (default)
  JEV_CACHE_MAX_ENTRIES maximum cached query/document pairs (default 5000)`;

export function parseArgs(argv, env) {
  const options = { port: 8787, host: '127.0.0.1', pack: Number(env.JEV_RERANK_PACK ?? 1), token: env.RERANK_SERVER_TOKEN || null, cacheTtl: Number(env.JEV_CACHE_TTL_SECONDS ?? 0), cacheMaxEntries: Number(env.JEV_CACHE_MAX_ENTRIES ?? 5000), help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--port', '--host', '--pack', '--token', '--cache-ttl', '--cache-max-entries'].includes(flag)) throw new Error(`Unknown argument ${flag}; see --help`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i++;
    if (flag === '--port') options.port = Number(value);
    else if (flag === '--host') options.host = value;
    else if (flag === '--pack') options.pack = Number(value);
    else if (flag === '--token') options.token = value;
    else if (flag === '--cache-ttl') options.cacheTtl = Number(value);
    else options.cacheMaxEntries = Number(value);
  }
  if (!(Number.isInteger(options.port) && options.port >= 0 && options.port <= 65_535)) throw new Error('--port must be an integer between 0 and 65535');
  if (!(Number.isInteger(options.pack) && options.pack >= 1 && options.pack <= LIMITS.maxPack)) throw new Error(`--pack must be an integer between 1 and ${LIMITS.maxPack}`);
  if (!(Number.isInteger(options.cacheTtl) && options.cacheTtl >= 0)) throw new Error('--cache-ttl must be an integer >= 0');
  if (!(Number.isInteger(options.cacheMaxEntries) && options.cacheMaxEntries >= 1)) throw new Error('--cache-max-entries must be an integer >= 1');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) { console.log(USAGE); return; }
  const provider = createJevClient({ provider: process.env.JEV_PROVIDER || 'jev', endpoint: process.env.JEV_ENDPOINT || undefined, model: process.env.JEV_MODEL || undefined });
  const limiter = createLimiter({
    concurrency: process.env.JEV_CONCURRENCY ? Number(process.env.JEV_CONCURRENCY) : 8,
    requestsPerMinute: process.env.JEV_REQUESTS_PER_MINUTE ? Number(process.env.JEV_REQUESTS_PER_MINUTE) : 1000,
  });
  const cache = options.cacheTtl > 0 ? createScoreCache({ ttlMs: options.cacheTtl * 1000, maxEntries: options.cacheMaxEntries }) : undefined;
  const server = createRerankServer({ provider, token: options.token, pack: options.pack, limiter, cache });
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const { address, port } = server.address();
  console.error(`jev-rerank-server listening on http://${address.includes(':') ? `[${address}]` : address}:${port} (pack=${options.pack}, token=${options.token ? 'required' : 'none'}, cache=${options.cacheTtl ? `${options.cacheTtl}s/${options.cacheMaxEntries}` : 'off'})`);
  const shutdown = () => { server.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Import-safe: tests import parseArgs without starting a server. realpath handles the npm bin symlink.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main().catch(error => { console.error(`jev-rerank-server: ${error.message}`); process.exitCode = 1; });
}
