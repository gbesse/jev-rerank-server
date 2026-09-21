---
description: Reproducible BEIR SciFact benchmark protocol for measuring BM25 retrieval and Jev reranking.
---

# Benchmark

`npm run benchmark:offline -- --limit 25` downloads the checksum-pinned BEIR SciFact archive and measures the BM25
candidate retriever. To measure live Jev reranking of the same deterministic query sample:

```sh
TYPESAFE_API_KEY=... npm run benchmark -- --limit 25 --candidates 20 --top-k 10 --pack 1
```

The seed and selected query IDs are written to the result. BM25 retrieves the candidate pool; Jev only reorders it.
`candidate_recall` therefore exposes the retrieval ceiling instead of attributing missed documents to the reranker.
The report includes nDCG@k, MRR@k, recall@k, elapsed time, input/output tokens, request count and estimated Jev cost.

Files ending in `.local.json` are ignored. A committed result must state the exact command, remain unedited, and must
not be generalized beyond the sampled dataset. SciFact is downloaded from the public URL used by the BEIR project;
its contents are not redistributed by this repository.
