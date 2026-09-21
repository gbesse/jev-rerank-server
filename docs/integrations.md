---
description: How to point LangChain, LlamaIndex, Haystack, Dify and Open WebUI at jev-rerank-server; each snippet says whether it was executed.
---

# Integrations

Start the server first (`TYPESAFE_API_KEY=... npx jev-rerank-server --port 8787`). Every snippet below was **written from
public documentation on 2026-09-21 and not executed here**; parameter names in third-party libraries change, so check
your installed version if a call fails. If you set `RERANK_SERVER_TOKEN`, use that value as the client-side API key;
otherwise any non-empty string works because the server ignores it.

The server answers on `/v1/rerank`, `/v2/rerank` and `/rerank`, so both "base URL + `/v1/rerank`" and "base URL +
`/rerank`" client conventions reach it.

## LangChain (Python, `langchain-cohere`)

```python
import cohere
from langchain_cohere import CohereRerank

# The Cohere SDK accepts a base_url; cohere.Client uses /v1/rerank, cohere.ClientV2 uses /v2/rerank. Both are served.
client = cohere.Client(api_key="not-used-unless-RERANK_SERVER_TOKEN", base_url="http://127.0.0.1:8787")
reranker = CohereRerank(client=client, model="jev-1.13.0", top_n=5)
docs = reranker.compress_documents(documents, query="How long do I have to return shoes?")
```

Some `langchain-cohere` versions also accept `CohereRerank(base_url=...)` directly. Written from public docs, not executed here.

## LlamaIndex (Python, `llama-index-postprocessor-cohere-rerank`)

```python
from llama_index.postprocessor.cohere_rerank import CohereRerank

reranker = CohereRerank(api_key="not-used-unless-RERANK_SERVER_TOKEN", model="jev-1.13.0", top_n=5, base_url="http://127.0.0.1:8787")
query_engine = index.as_query_engine(node_postprocessors=[reranker])
```

If your version has no `base_url` argument, set the Cohere SDK's `CO_API_URL` environment variable to
`http://127.0.0.1:8787` before creating the client. Written from public docs, not executed here.

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
