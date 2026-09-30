---
description: Exact HTTP contract of jev-rerank-server: routes, accepted request fields, response envelopes, limits and error bodies.
---

# Protocol

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/rerank` | Cohere v1, Jina and Voyage clients |
| `POST` | `/v2/rerank` | Cohere v2 clients |
| `POST` | `/rerank` | Alias for tools that append `/rerank` to a base URL |
| `GET` | `/healthz` | Model, pack and optional exact-cache status, no token needed |
| `GET` | `/v1/models` | Pinned model and accepted aliases, no token needed |

All three rerank routes run the same code. Bodies are JSON; responses are JSON with `content-type: application/json`.

## Authentication

When `RERANK_SERVER_TOKEN` (or `--token`) is set, rerank routes require `Authorization: Bearer <token>` or `X-API-Key: <token>`;
otherwise the client's key header is ignored. Put your real Jev key only in the server's `TYPESAFE_API_KEY`.

## Request fields

| Field | Accepted values | Notes |
| --- | --- | --- |
| `model` | any string, or absent | Echoed back unchanged as `model`; the answer always comes from `jev-1.13.0`, reported as `served_by` |
| `query` | non-empty string, at most 4,000 characters | Required |
| `documents` | array of at most 1,000 items | Each item is a string, an object with a string `text`, or any object whose string fields are joined as `field: value` lines |
| `rank_fields` | array of field names | Cohere v2: only these fields are ranked, in the given order |
| `top_n` | positive integer | Cohere and Jina: number of results to return |
| `top_k` | positive integer | Voyage: number of results to return; its presence selects the Voyage envelope |
| `return_documents` | boolean, default `false` | Jina defaults this to `true` upstream; here it must be explicit |
| `max_chunks_per_doc` | anything | Ignored with a warning in `meta.warnings` (Cohere/Jina) or `warnings` (Voyage) |

Documents longer than 20,000 characters are truncated to 20,000 and the result carries `truncated: true`. Failing the
whole call for one long chunk would break pipelines that cannot resize stored chunks; truncation keeps the call
answerable and visible.

## Response envelopes

Cohere/Jina (no `top_k` in the request):

```json
{
  "id": "uuid",
  "results": [{ "index": 2, "relevance_score": 0.91, "document": { "text": "..." }, "truncated": true }],
  "model": "rerank-v3.5",
  "served_by": "jev-1.13.0",
  "usage": { "total_tokens": 360, "prompt_tokens": 360, "jev_requests": 3, "unique_documents": 3, "deduplicated_documents": 0, "cached_documents": 0, "scored_documents": 3, "estimated_cost_usd": 0.00001512 },
  "meta": { "api_version": { "version": "2" }, "billed_units": { "search_units": 1 }, "warnings": ["..."] }
}
```

`document` is present only with `return_documents: true`: `{ text }` for string inputs, the original object for object
inputs. `truncated` is present only when true. `warnings` is present only when non-empty.

Voyage (`top_k` present):

```json
{
  "object": "list",
  "data": [{ "index": 2, "relevance_score": 0.91, "document": "..." }],
  "model": "rerank-2",
  "served_by": "jev-1.13.0",
  "usage": { "total_tokens": 360, "jev_requests": 3, "unique_documents": 3, "deduplicated_documents": 0, "cached_documents": 0, "scored_documents": 3, "estimated_cost_usd": 0.00001512 }
}
```

Results are sorted by `relevance_score` descending; ties keep the original document order. `total_tokens` sums Jev
`input_tokens` and `output_tokens` over every request made for the call; `estimated_cost_usd` is `input_tokens × 0.042 / 1e6`
from the published price list, rounded to nanodollars, and is an estimate rather than a bill. With the optional exact
cache enabled, `cached_documents` counts distinct rendered documents reused across calls and `scored_documents` counts
the distinct misses sent to Jev. Repeated documents inside the same request remain visible in `deduplicated_documents`.

## Errors

Every error is `{ "message": "..." }`:

| Status | When |
| --- | --- |
| 400 | Invalid JSON, missing query, bad field types, more than 1,000 documents, query over 4,000 characters |
| 401 | Server token configured and missing or wrong |
| 404 / 405 | Unknown route / non-POST on a rerank route |
| 413 | Body over 32 MiB |
| 502 | Jev returned an error (after bounded retries on 429 and 529) or an invalid response; no partial ranking is returned |
| 504 | Jev did not answer within the client timeout (30 s by default) |
| 500 | Unexpected server failure; the stack goes to stderr, the body stays generic |

The Jev key is redacted from every message before it leaves the process.
