# Jev Rerank

[Français](README.fr.md) · English · [Español](README.es.md)

## New: rerank with Cloudflare Clef

Choose `JEV_PROVIDER=clef` and `JEV_MODEL=clef` or `clef-flash` to use the same rerank routes with Cloudflare Workers AI. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` in your environment, then run `npm start`. The adapter sends System One questions to Cloudflare's REST endpoint, unwraps its `result` envelope, validates typed answers, and uses the selected Clef input-token rate for the estimate. `npm test` exercises this path with synthetic replies; a live Cloudflare request has not been verified in this release.

**Related projects:** [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) documents the REST shape and current model price; [Hindsight #5455](https://github.com/vectorize-io/hindsight/issues/5455) reports the practical need for a Clef reranker adapter. This package is independent of both projects. Its existing Cohere/Jina/Voyage-compatible HTTP routes are the actual integration surface.

```sh
npm run demo
# Live, only with your own Cloudflare account and token:
JEV_PROVIDER=clef JEV_MODEL=clef-flash npm start
```

**A drop-in rerank API served by Jev for teams whose RAG stack already has a "rerank base URL" setting.**

[![Tests](https://github.com/gbesse/jev-rerank-server/actions/workflows/test.yml/badge.svg)](https://github.com/gbesse/jev-rerank-server/actions/workflows/test.yml)
[MIT](LICENSE) · Node.js 22+ · No runtime dependencies · v0.5.2

The server speaks the Cohere `/v1/rerank` and `/v2/rerank`, Jina `/v1/rerank` and Voyage `/v1/rerank` request and
response shapes. LangChain, LlamaIndex, Haystack, Dify, Open WebUI and any client with a configurable rerank endpoint
can use Jev by changing a URL. Each (query, document) pair becomes one typed yes/no question to Jev; the returned
probability is the relevance score.

```text
POST /v2/rerank { query, documents, top_n }
   → one Jev request per document: state { query, passage }, noul "relevant"
   → relevance_score = probability, sorted, top_n applied
   → Cohere/Jina envelope (or Voyage envelope when top_k was sent)
```

## Run it

```sh
git clone https://github.com/gbesse/jev-rerank-server.git
cd jev-rerank-server
npm ci --ignore-scripts
npm run demo
npm test
```

The demo starts the server on loopback with a synthetic provider and sends Cohere-, Jina- and Voyage-shaped requests.
No key, install or build is required. The demo and test scores are synthetic (share of query words found in the passage),
not measured Jev output.

To see how duplicate documents and an exact score cache affect request counts, run `node examples/cache-savings.mjs`. It reranks the same fictional return-policy documents twice, then changes the query; the printed `jev_requests` and `cached_documents` are from a local synthetic provider, never the paid API.

## Call real Jev

```sh
export TYPESAFE_API_KEY=...        # requests are paid and go to https://api.typesafe.ai/v1/systemone
npm start -- --port 8787 --host 127.0.0.1
curl -s http://127.0.0.1:8787/v2/rerank -H 'content-type: application/json' \
  -d '{"query":"How long do I have to return shoes?","documents":["Returns are accepted within 30 days.","Free shipping above 80 euros."],"top_n":1,"return_documents":true}'
```

Options: `--pack N` (passages per Jev request, default 1), `--token TOKEN` (bearer clients must send),
`--cache-ttl SECONDS` and `--cache-max-entries N`. Environment:
`TYPESAFE_API_KEY` (required), `RERANK_SERVER_TOKEN`, `JEV_RERANK_PACK`, `JEV_CONCURRENCY` (default 8),
`JEV_REQUESTS_PER_MINUTE` (default 1,000), `JEV_CACHE_TTL_SECONDS` (default 0/off),
`JEV_CACHE_MAX_ENTRIES` (default 5,000), `JEV_ENDPOINT` (HTTPS only, loopback HTTP for tests).

Every response reports `usage.total_tokens`, `usage.jev_requests` and `usage.estimated_cost_usd`
(`input_tokens × 0.042 / 1e6`, an estimate from the published price list, not a bill). With the default pairwise mode,
reranking 20 documents of about 500 characters costs roughly 20 × 180 tokens ≈ 3,600 tokens ≈ USD 0.00015.
Identical rendered documents inside one request are evaluated once; `usage.unique_documents` and
`usage.deduplicated_documents` make the saved calls explicit while results retain every original index.

For repeated retrieval traffic, opt into the bounded process-local exact cache with `--cache-ttl 300`. A second
identical `(query, rendered document)` pair then reuses its score and reports it in `usage.cached_documents`; only
misses count in `usage.scored_documents`, `jev_requests`, tokens and estimated cost. Entries expire without sliding
their TTL, least-recently-used entries are evicted at the configured bound, failures are never cached, and restarting
the process clears everything. The cache is off by default because even a pinned model can change operationally.

Docker: `docker compose up` builds `node:24-alpine` with no build step and publishes `127.0.0.1:8787`; set
`TYPESAFE_API_KEY` in the host environment first.

The official SDKs (`@typesafe-ai/sdk` on npm, `typesafe-sdk` on PyPI) are an alternative for your own code; this server
ships its own minimal client so nothing extra is installed.

The release tarball can also be installed without cloning: `npm install -g
https://github.com/gbesse/jev-rerank-server/releases/download/v0.5.2/jev-rerank-0.5.2.tgz`, then run `jev-rerank`.
The npm name is reserved in the manifest but registry publication requires maintainer npm authentication.

## Measured on BEIR SciFact

The checked-in v0.2 benchmark uses BM25 to retrieve 20 candidates and Jev pairwise mode only to reorder them. On a
deterministic 25-query sample, at `k=10`:

| Ranker | nDCG@10 | MRR@10 | Recall@10 |
| --- | ---: | ---: | ---: |
| BM25 | 0.616377 | 0.548159 | 0.84 |
| BM25 → Jev | **0.718260** | **0.685048** | 0.84 |

The live run made 500 Jev requests, consumed 369,576 input tokens, cost an estimated **$0.015522**, and took 16.9
seconds from this development machine. Candidate recall was 0.84, so the reranker could not recover missing documents.
This small English scientific-claims sample is evidence, not a universal quality claim. See the
[complete result](benchmarks/results/scifact-jev-25.json) and [reproduction protocol](benchmarks/README.md).

## Point your framework at it

See [docs/integrations.md](docs/integrations.md) for the Cohere Python compatibility test plus LangChain, LlamaIndex,
Haystack, Dify and Open WebUI configuration, and [docs/protocol.md](docs/protocol.md) for the exact contract.

Use it as a library when you want the pipeline without HTTP:

```js
import { createJevClient, createRerankServer, rerank } from 'jev-rerank';

const provider = createJevClient();                 // reads TYPESAFE_API_KEY
const response = await rerank({ query, documents, top_n: 5 }, { provider });
console.log(response.results, response.usage.estimated_cost_usd);

createRerankServer({ provider, token: process.env.RERANK_SERVER_TOKEN }).listen(8787, '127.0.0.1');
```

Errors propagate: a failed Jev call rejects `rerank()` and yields an HTTP 502 with `{ message }` from the server. Tests
use `createSyntheticRerankProvider()` or `createFakeProvider(fixtures)`, which never touch the network.

## How it decides

Run `node examples/cache-savings.mjs` to compare a first query, a repeated query, a changed query and a return to the first query. The synthetic demo reports requests, duplicate documents and cache hits; changing the query must not reuse the previous query's scores. / La démonstration distingue les requêtes et les résultats en cache sans appel Jev. / La demostración distingue las consultas y los resultados en caché sin llamar a Jev.

Pairwise mode (default, one request per document), faithful to TypeSafe's rerank cookbook:

- State: `{ "query": "<query>", "passage": "<document text>" }`.
- Question `relevant`, type `noul`, instructions: *"Does the passage directly answer the query or contain the specific
  information the query asks for?"*
- Criteria true: *"The passage states the specific fact, answer or content the query is looking for."*
  Criteria false: *"The passage is only on a related topic, mentions the same words, or does not contain what the query
  asks for."*
- `relevance_score` is the returned probability, unchanged. Results are sorted descending; ties keep the original order;
  `top_n`/`top_k` is applied after sorting.

Packed mode (`--pack N`, 2 to 20): one request holds up to N passages as `{ query, passages: { p1, p2, ... } }` with one
`noul` per passage naming its id. It divides the number of requests by N but puts N−1 irrelevant passages in every
question's state, and Jev's accuracy drops with irrelevant state. Use it when throughput matters more than ordering
precision, and measure on your own data first.

Code-owned rules: model names are echoed and always served by `jev-1.13.0`; the response `model` is verified against the
request; documents over 20,000 characters are truncated and flagged with `truncated: true`; more than 1,000 documents or
a query over 4,000 characters is a 400; `max_chunks_per_doc` is ignored with a warning; states over an estimated 24,000
tokens are refused before sending. Jev calls run through an in-process limiter (8 concurrent, 1,000 requests per
minute) and retry only on 429, 529 and network errors with jittered backoff, honouring `retry-after`. One failed
request aborts the others and the call returns 502 rather than a partial ranking.

`GET /healthz` reports the pinned model, pack size and cache configuration/current entry count. It never calls Jev and
remains unauthenticated for container probes. `GET /metrics` exposes process-local Prometheus counters for response
classes, latency, documents, cache savings, Jev calls, tokens and estimated cost. It never contains query or document
content. When `RERANK_SERVER_TOKEN` is configured, `/metrics` requires the same bearer token; `/healthz` stays open.

## Boundaries

- The checked-in benchmark covers 25 English SciFact queries. It does not establish quality for another language,
  domain, candidate retriever or chunk size. Run the same harness on labeled examples from your corpus.
- One document is one Jev question; the score depends on the query and passage only. There is no cross-document
  comparison, no chunking, no semantic embedding fallback.
- Jev reads instructions literally, counts unreliably and compares numbers and dates poorly. Queries such as "the
  cheapest option" or "documents after March 2024" get keyword-level judgments, not arithmetic.
- Documents are sent as-is: injected instructions inside a passage can sway its score. Do not rerank untrusted text for
  authorization decisions.
- English works best; other languages work with lower accuracy.
- Not a hosted service: bind to loopback or put it behind your own TLS and authentication. `RERANK_SERVER_TOKEN` is a
  shared secret, not user management.
- `return_documents` defaults to `false` on every route, unlike Jina's own API.

## Validation

```sh
npm run check       # node --check on every .mjs
npm run typecheck   # tsc --noEmit against docs/public-api-types.mts (needs npm ci --ignore-scripts)
npm test            # node --test against a fake Jev server on loopback
npm run demo        # offline synthetic run
npm run benchmark:offline -- --limit 25
# pip install cohere==5.21.1 && npm run test:cohere
# pip install -r integrations/requirements-frameworks.txt && npm run test:frameworks
```

CI runs the core commands on Node 22 and 24, Cohere Python `ClientV2`, and **13 real LangChain/LlamaIndex wrapper tests**
against the synthetic server on Python 3.11/3.12. See [versions, results and reproduction](docs/framework-compatibility.md).
These are protocol tests, not a live model-quality benchmark.
`scripts/live-smoke.mjs` makes at most two paid Jev requests when `TYPESAFE_API_KEY` is set. The live benchmark
is deliberately manual because it makes paid requests.

## Related projects

- [DecisionPacks](https://github.com/gbesse/decisionpacks): versioned decision contracts with the same Jev client design.
- [Autonomy Meter](https://github.com/gbesse/autonomy-meter): calibrate thresholds on labeled outcomes with a holdout.
- [Question Forge](https://github.com/gbesse/question-forge): author and test Jev questions before wiring them.

Independent project; not affiliated with TypeSafe AI. Protocol reference:
[TypeSafe API](https://docs.typesafe.ai/api) and [known model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## October 2026 improvement · Amélioration d’octobre 2026 · Mejora de octubre de 2026

Requests containing both Cohere `top_n` and Voyage `top_k` now receive a 400 validation error, so the response envelope is never chosen ambiguously. Run `npm test` offline.

Les requêtes mêlant `top_n` de Cohere et `top_k` de Voyage reçoivent désormais une erreur 400 ; le format de réponse n’est plus ambigu. Lancez `npm test` hors ligne.

Las solicitudes que mezclan `top_n` de Cohere y `top_k` de Voyage ahora reciben un error 400; el formato de respuesta deja de ser ambiguo. Ejecute `npm test` sin conexión.
