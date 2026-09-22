"""Real wrappers over loopback HTTP; synthetic relevance, no hosted API or model key."""
import asyncio
import os
import unittest
from importlib.metadata import version

from cohere.core.api_error import ApiError
from langchain_cohere import CohereRerank as LangChainRerank
from langchain_core.documents import Document
from llama_index.core.schema import NodeWithScore, TextNode
from llama_index.postprocessor.cohere_rerank import CohereRerank as LlamaIndexRerank

URL = os.environ["JEV_RERANK_BASE_URL"]
TOKEN = "integration-test-token"  # Public test fixture, not a credential.
MODEL = "rerank-v3.5"  # Keep the existing Cohere model alias; change the endpoint.
QUERY = "returns shoes"
TEXTS = ["Shipping costs five euros.", "Returns accepted.",
         "Returns for shoes accepted.", "Shoes qualify for returns."]


class ContractChecks:
    def test_top_one_selects_nonfirst_document(self):
        self.assertEqual(self.call(top_n=1), [(2, 1.0)])

    def test_top_two_preserves_tie_order(self):
        self.assertEqual(self.call(top_n=2), [(2, 1.0), (3, 1.0)])

    def test_all_scores_and_order(self):
        self.assertEqual(self.call(top_n=4), [(2, 1.0), (3, 1.0), (1, 0.5), (0, 0.0)])

    def test_empty_input(self):
        self.assertEqual(self.call(empty=True), [])

    def test_wrong_token_propagates_401(self):
        with self.assertRaises(ApiError) as raised:
            self.call(token="deliberately-wrong")
        self.assertEqual(raised.exception.status_code, 401)

    def test_invalid_query_propagates_400(self):
        with self.assertRaises(ApiError) as raised:
            self.call(query="")
        self.assertEqual(raised.exception.status_code, 400)


class LangChainCompatibility(ContractChecks, unittest.TestCase):
    def call(self, top_n=2, token=TOKEN, query=QUERY, empty=False, asynchronous=False):
        documents = [] if empty else [
            Document(page_content=text, metadata={"source": i, "nested": {"keep": True}})
            for i, text in enumerate(TEXTS)
        ]
        before = [doc.model_dump() for doc in documents]
        reranker = LangChainRerank(cohere_api_key=token, model=MODEL, top_n=top_n, base_url=URL)
        self.enterContext(reranker.client)
        if asynchronous:
            result = asyncio.run(reranker.acompress_documents(documents, query=query))
        else:
            result = reranker.compress_documents(documents, query=query)
        self.assertEqual([doc.model_dump() for doc in documents], before)
        for doc in result:
            original = documents[doc.metadata["source"]]
            self.assertEqual(doc.page_content, original.page_content)
            self.assertEqual(doc.metadata["nested"], original.metadata["nested"])
            self.assertIsNot(doc.metadata["nested"], original.metadata["nested"])
        return [(doc.metadata["source"], doc.metadata["relevance_score"]) for doc in result]

    def test_async_compression(self):
        self.assertEqual(self.call(asynchronous=True), [(2, 1.0), (3, 1.0)])


class LlamaIndexCompatibility(ContractChecks, unittest.TestCase):
    def call(self, top_n=2, token=TOKEN, query=QUERY, empty=False):
        nodes = [] if empty else [NodeWithScore(node=TextNode(
            text=text, id_=f"fixture-{i}", metadata={"source": i},
            excluded_embed_metadata_keys=["source"],
        ), score=0.123) for i, text in enumerate(TEXTS)]
        before = [node.model_dump() for node in nodes]
        reranker = LlamaIndexRerank(api_key=token, model=MODEL, top_n=top_n, base_url=URL)
        # Lifecycle cleanup only: leave the wrapper-created client and transport unchanged.
        self.enterContext(reranker._client)
        result = reranker.postprocess_nodes(nodes, query_str=query)
        self.assertEqual([node.model_dump() for node in nodes], before)
        for node in result:
            original = nodes[node.node.metadata["source"]]
            self.assertIs(node.node, original.node)
            self.assertEqual(node.node.node_id, original.node.node_id)
        return [(node.node.metadata["source"], node.score) for node in result]


if __name__ == "__main__":
    for package in ("cohere", "langchain-cohere", "langchain-core",
                    "llama-index-postprocessor-cohere-rerank", "llama-index-core"):
        print(f"{package}=={version(package)}", flush=True)
    unittest.main(verbosity=2)
