"""Purpose: Prove that the real Cohere Python v2 client can call jev-rerank-server by changing only base_url."""
import os
import cohere

client = cohere.ClientV2(
    api_key="integration-test-token",
    base_url=os.environ["JEV_RERANK_BASE_URL"],
    timeout=10,
)
response = client.rerank(
    model="rerank-v3.5",
    query="How long can I return shoes?",
    documents=["Returns are accepted for 30 days.", "Shipping is free above 80 euros."],
    top_n=1,
)
assert len(response.results) == 1
assert response.results[0].index == 0
assert 0 <= response.results[0].relevance_score <= 1
print("Cohere ClientV2 compatibility smoke passed")
