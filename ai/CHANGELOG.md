# AI changelog

This file records implementation decisions and validation for each change made with an AI assistant.

## 2026-09-21 — v0.2.0 product completion

- Renamed the distributable package to the available, unscoped `jev-rerank` name and exposed both `jev-rerank` and
  `jev-rerank-server` commands; prepared public npm provenance publishing and tagged-release packaging.
- Added a checksum-pinned BEIR SciFact benchmark with deterministic sampling, an in-repo BM25 candidate retriever,
  candidate-recall ceiling, nDCG/MRR/recall metrics, elapsed time, requests, token usage and estimated cost.
- Committed the unedited 25-query live result: Jev improved nDCG@10 from 0.616377 to 0.718260 and MRR@10 from
  0.548159 to 0.685048 at equal 0.84 recall, using 500 calls and an estimated $0.015522.
- Added an integration smoke that executes `cohere==5.21.1` `ClientV2` against the HTTP service and runs in CI.
- Locally validated syntax, declarations, 32 unit/integration tests, offline demo, two-call live smoke, the live
  benchmark, the real Cohere SDK smoke, and package contents. No Docker validation was possible because Docker is not
  installed on this host. npm publication remains gated by maintainer registry authentication.

## 2026-09-21 — Initial public alpha

- Purpose: protocol-compatible rerank server backed by Jev (Cohere `/v1/rerank` and `/v2/rerank`, Jina `/v1/rerank`, Voyage `/v1/rerank` shapes) so frameworks with a "rerank base URL" setting can use Jev without code changes.
- Native `node:http`, ESM `.mjs`, no runtime dependencies, no build step; `typescript` 5.9.3 only for declaration checks.
- Scoring follows TypeSafe's rerank cookbook: one request per (query, passage) pair, one `noul` question, `relevance_score = noul`. Packed mode (`--pack N`) is opt-in and documented as trading accuracy for throughput.
- Jev client: pinned `jev-1.13.0`, HTTPS-only outside loopback, `redirect: 'error'`, `AbortSignal.timeout` combined with caller signals, retries only on 429/529/network with jittered backoff and `retry-after`, strict response validation, key redaction, 24k-token state budget.
- One failing Jev request aborts the sibling requests and yields a 502 without partial results; timeouts map to 504.
- Response shape chosen by `top_k` (Voyage) versus `top_n`/none (Cohere/Jina). Cost estimate rounded to nanodollars from the published price (USD 0.042 per million input tokens).
- Validation passed locally: `npm run check`, `npm run typecheck`, `npm test` (32 cases against a loopback fake Jev), `npm run demo`. No build. No live Jev call was made; `scripts/live-smoke.mjs` is provided for the maintainer.
- Not verified: the integration snippets in `docs/integrations.md` were written from public documentation and not executed; no accuracy benchmark was run.
