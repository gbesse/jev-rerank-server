# Real framework compatibility tests

Local result, 2026-09-22: **13/13 wrapper tests passed**, plus **32/32 Node tests**.
The actual LangChain and LlamaIndex packages call the real HTTP handler on loopback.
Only relevance scoring is synthetic; no TypeSafe/Cohere key or hosted service is used.

## Tested versions

| Package | Version |
| --- | --- |
| cohere | 5.21.1 |
| langchain-cohere | 0.6.0 |
| langchain-core | 1.6.4 |
| llama-index-postprocessor-cohere-rerank | 0.10.0 |
| llama-index-core | 0.14.25 |

Local runtime: Python 3.11.3, Node 24.11.1 on macOS arm64.
The `framework-python` CI matrix runs Python 3.11 and 3.12 on Ubuntu with Node 24.
[GitHub Actions](https://github.com/gbesse/jev-rerank-server/actions/workflows/test.yml)
prints test names, installed versions and the complete `pip freeze` environment.
Direct wrapper/SDK/core dependencies are pinned; transitive dependencies are not locked.

## What passes

Each wrapper has six checks: top-1 selecting a document other than the first input;
top-2 with stable ties; complete score/order mapping; empty input; wrong-token 401;
invalid-query 400. LangChain also passes asynchronous compression: **13 tests total**.
Successful nonempty calls also check preservation of source text/metadata and no input mutation.
LlamaIndex additionally retains the original node objects/IDs; LangChain deep-copies metadata.

The server independently observes **11 POST /v2/rerank requests**:
7 successful responses, 2 unauthorized responses and 2 validation errors.
Both wrappers short-circuit empty collections without making an HTTP request.
The deterministic fixture uses query `returns shoes`, with expected indices
`[2, 3, 1, 0]` and scores `[1, 1, 0.5, 0]`.

Both wrappers construct their own unmodified Cohere client with `base_url` pointing at
Jev Rerank. No client injection, monkeypatch, custom adapter or server change is needed.
The existing `rerank-v3.5` model alias remains accepted, but the server does not run Cohere's model.
For an authenticated server, the API-key field must contain that server's token.

## Reproduce

From a repository checkout (Node >=22, Python 3.11 or 3.12):

```sh
python3 -m venv .venv
.venv/bin/pip install -r integrations/requirements-frameworks.txt
PYTHON=.venv/bin/python npm run test:frameworks
# Existing Cohere SDK smoke test, independently:
PYTHON=.venv/bin/python npm run test:cohere
# Core checks:
npm ci --ignore-scripts
npm run release:check
```

Source: [Python assertions](../integrations/framework_compatibility.py),
[HTTP runner](../scripts/verify-frameworks-python.mjs),
[CI workflow](../.github/workflows/test.yml).

## Limits

This demonstrates protocol compatibility for these pinned versions, not live Jev ranking
quality, latency, throughput or every version/option of either framework. Scores are synthetic.
No embedding model, retriever, full RAG pipeline, streaming path or hosted provider is exercised.
The separately documented SciFact benchmark is not rerun by this suite.
