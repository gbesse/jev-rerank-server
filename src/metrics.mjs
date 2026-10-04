// Purpose: Aggregate process-local rerank telemetry and expose it in Prometheus' text format without request content.

const finite = (value) => (Number.isFinite(value) ? value : 0);

export function createMetrics() {
  const values = {
    requests: 0,
    inFlight: 0,
    durationSeconds: 0,
    documents: 0,
    uniqueDocuments: 0,
    deduplicatedDocuments: 0,
    cachedDocuments: 0,
    scoredDocuments: 0,
    jevRequests: 0,
    tokens: 0,
    estimatedCostUsd: 0,
    statuses: new Map(),
  };

  return {
    begin() {
      values.requests++;
      values.inFlight++;
    },
    finish({ status, durationSeconds, usage = null, documents = 0 }) {
      values.inFlight = Math.max(0, values.inFlight - 1);
      values.durationSeconds += finite(durationSeconds);
      const statusClass = `${Math.floor(status / 100)}xx`;
      values.statuses.set(
        statusClass,
        (values.statuses.get(statusClass) ?? 0) + 1,
      );
      if (!usage) return;
      values.documents += documents;
      values.uniqueDocuments += usage.unique_documents;
      values.deduplicatedDocuments += usage.deduplicated_documents;
      values.cachedDocuments += usage.cached_documents;
      values.scoredDocuments += usage.scored_documents;
      values.jevRequests += usage.jev_requests;
      values.tokens += usage.total_tokens;
      values.estimatedCostUsd += usage.estimated_cost_usd;
    },
    snapshot() {
      return {
        requests: values.requests,
        inFlight: values.inFlight,
        durationSeconds: values.durationSeconds,
        documents: values.documents,
        uniqueDocuments: values.uniqueDocuments,
        deduplicatedDocuments: values.deduplicatedDocuments,
        cachedDocuments: values.cachedDocuments,
        scoredDocuments: values.scoredDocuments,
        jevRequests: values.jevRequests,
        tokens: values.tokens,
        estimatedCostUsd: values.estimatedCostUsd,
        statuses: Object.fromEntries(values.statuses),
      };
    },
    render() {
      const statusLines = [...values.statuses]
        .sort()
        .map(
          ([status, count]) =>
            `jev_rerank_http_responses_total{status="${status}"} ${count}`,
        );
      return `${[
        "# HELP jev_rerank_http_requests_total Rerank HTTP requests received.",
        "# TYPE jev_rerank_http_requests_total counter",
        `jev_rerank_http_requests_total ${values.requests}`,
        "# HELP jev_rerank_http_responses_total Rerank HTTP responses by status class.",
        "# TYPE jev_rerank_http_responses_total counter",
        ...statusLines,
        "# HELP jev_rerank_in_flight Rerank HTTP requests currently running.",
        "# TYPE jev_rerank_in_flight gauge",
        `jev_rerank_in_flight ${values.inFlight}`,
        "# HELP jev_rerank_request_duration_seconds_sum Cumulative rerank request duration.",
        "# TYPE jev_rerank_request_duration_seconds_sum counter",
        `jev_rerank_request_duration_seconds_sum ${values.durationSeconds}`,
        "# HELP jev_rerank_documents_total Documents submitted in successful requests.",
        "# TYPE jev_rerank_documents_total counter",
        `jev_rerank_documents_total ${values.documents}`,
        `jev_rerank_unique_documents_total ${values.uniqueDocuments}`,
        `jev_rerank_deduplicated_documents_total ${values.deduplicatedDocuments}`,
        `jev_rerank_cached_documents_total ${values.cachedDocuments}`,
        `jev_rerank_scored_documents_total ${values.scoredDocuments}`,
        "# HELP jev_rerank_jev_requests_total Paid Jev requests made for successful reranks.",
        "# TYPE jev_rerank_jev_requests_total counter",
        `jev_rerank_jev_requests_total ${values.jevRequests}`,
        `jev_rerank_tokens_total ${values.tokens}`,
        `jev_rerank_estimated_cost_usd_total ${values.estimatedCostUsd}`,
      ].join("\n")}\n`;
    },
  };
}
