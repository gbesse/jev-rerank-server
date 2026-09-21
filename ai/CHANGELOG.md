# AI changelog

This file records implementation decisions and validation for each change made with an AI assistant.

## 2026-09-21 — Initial public alpha

- Purpose: protocol-compatible rerank server backed by Jev (Cohere `/v1/rerank` and `/v2/rerank`, Jina `/v1/rerank`, Voyage `/v1/rerank` shapes) so frameworks with a "rerank base URL" setting can use Jev without code changes.
- Native `node:http`, ESM `.mjs`, no runtime dependencies, no build step; `typescript` 5.9.3 only for declaration checks.
- Scoring follows TypeSafe's rerank cookbook: one request per (query, passage) pair, one `noul` question, `relevance_score = noul`. Packed mode (`--pack N`) is opt-in and documented as trading accuracy for throughput.
- Jev client: pinned `jev-1.13.0`, HTTPS-only outside loopback, `redirect: 'error'`, `AbortSignal.timeout` combined with caller signals, retries only on 429/529/network with jittered backoff and `retry-after`, strict response validation, key redaction, 24k-token state budget.
- One failing Jev request aborts the sibling requests and yields a 502 without partial results; timeouts map to 504.
- Response shape chosen by `top_k` (Voyage) versus `top_n`/none (Cohere/Jina). Cost estimate rounded to nanodollars from the published price (USD 0.042 per million input tokens).
- Validation passed locally: `npm run check`, `npm run typecheck`, `npm test` (32 cases against a loopback fake Jev), `npm run demo`. No build. No live Jev call was made; `scripts/live-smoke.mjs` is provided for the maintainer.
- Not verified: the integration snippets in `docs/integrations.md` were written from public documentation and not executed; no accuracy benchmark was run.
