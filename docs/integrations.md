---
description: How to point LangChain, LlamaIndex, Haystack, Dify and Open WebUI at jev-rerank-server; each snippet says whether it was executed.
---

# Integrations

Start the server first (`TYPESAFE_API_KEY=... npm start -- --port 8787`). The Cohere Python v2 client and the real
LangChain and LlamaIndex rerank wrappers are executed in CI against the local synthetic server. See the
[compatibility test report](framework-compatibility.md) for versions, reproduction and scope.
If you set `RERANK_SERVER_TOKEN`, use that value as the client-side API
key; otherwise any non-empty string works because the server ignores it.

The server answers on `/v1/rerank`, `/v2/rerank` and `/rerank`, so both "base URL + `/v1/rerank`" and "base URL +
`/rerank`" client conventions reach it.

## Cohere Python v2 — executed in CI

```python
import cohere

client = cohere.ClientV2(api_key="client-token", base_url="http://127.0.0.1:8787", timeout=10)
response = client.rerank(model="rerank-v3.5", query="How long can I return shoes?", documents=documents, top_n=5)
```

`npm run test:cohere` executes this flow with `cohere==5.21.1`; see `integrations/cohere_v2_smoke.py`.

## LangChain (Python, `langchain-cohere==0.6.0`) — executed in CI

```python
from langchain_cohere import CohereRerank

reranker = CohereRerank(
    cohere_api_key="not-used-unless-RERANK_SERVER_TOKEN",
    model="rerank-v3.5", top_n=5, base_url="http://127.0.0.1:8787",
)
docs = reranker.compress_documents(documents, query="How long do I have to return shoes?")
```

This version creates its own Cohere `ClientV2` and sends `/v2/rerank`; no custom client or adapter is needed.
The synchronous and inherited asynchronous compression methods are tested. If you inject a client explicitly,
this version requires `cohere.ClientV2`, not the older `cohere.Client`.

## LlamaIndex (Python, `llama-index-postprocessor-cohere-rerank==0.10.0`) — wrapper executed in CI

```python
from llama_index.postprocessor.cohere_rerank import CohereRerank

reranker = CohereRerank(api_key="not-used-unless-RERANK_SERVER_TOKEN", model="rerank-v3.5", top_n=5, base_url="http://127.0.0.1:8787")
reranked_nodes = reranker.postprocess_nodes(nodes, query_str="How long do I have to return shoes?")
```

`nodes` is a list of `NodeWithScore` objects. This version creates its own `ClientV2` and sends `/v2/rerank`.
The wrapper is tested directly, not a complete index/embedding/query-engine pipeline.
Both examples retain a Cohere model alias: the server still serves Jev, not the named Cohere model.

## Haystack (Python, `cohere-haystack`)

```python
from haystack.utils import Secret
from haystack_integrations.components.rankers.cohere import CohereRanker

ranker = CohereRanker(
    model="jev-1.13.0",
    top_k=5,
    api_key=Secret.from_token("not-used-unless-RERANK_SERVER_TOKEN"),
    api_base_url="http://127.0.0.1:8787",
)
result = ranker.run(query="How long do I have to return shoes?", documents=documents)
```

Written from public docs, not executed here.

## Dify

Dify's Jina AI model provider supports rerank models with a custom endpoint. In **Settings → Model Provider → Jina →
Add Model**, choose *Rerank*, set the model name to `jev-1.13.0`, the API key to your `RERANK_SERVER_TOKEN` (or any
string) and the base URL to `http://<host>:8787` (Dify appends `/v1/rerank`). If the field is labelled differently in your
version, look for "Custom API endpoint URL". Then select the model as the rerank model in your knowledge base retrieval
settings. Written from public docs, not executed here.

## Open WebUI

In **Admin Panel → Settings → Documents**, set *Reranking Engine* to **External**, the engine URL to
`http://<host>:8787/v1` and the API key to your `RERANK_SERVER_TOKEN` (or any string). Open WebUI sends
`{ model, query, documents, top_n }` and reads `results[].index` and `results[].relevance_score`, which is the Cohere
shape served here. If your version posts to the URL verbatim instead of appending `/rerank`, use
`http://<host>:8787/v1/rerank`. The same settings exist as environment variables `RAG_EXTERNAL_RERANKER_URL` and
`RAG_EXTERNAL_RERANKER_API_KEY`. Written from public docs, not executed here.

## Anything else that speaks Cohere, Jina or Voyage rerank

```sh
curl -s http://127.0.0.1:8787/v2/rerank \
  -H 'content-type: application/json' \
  -d '{"model":"rerank-v3.5","query":"How long do I have to return shoes?","documents":["Returns are accepted within 30 days.","Free shipping above 80 euros."],"top_n":1}'
```

This one is executed by `npm run demo` against the offline synthetic provider, and by `npm test` against a fake Jev
server. Voyage clients send `top_k` and receive the `{ object, data }` envelope; see [protocol.md](protocol.md).
