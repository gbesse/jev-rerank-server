// Purpose: Hand-written public API declarations for TypeScript consumers; no build step produces them.

/** Structural subset of node:http.Server, declared here so consumers do not need @types/node to type-check. */
export interface RerankServer {
  listen(port?: number, host?: string, callback?: () => void): this;
  close(callback?: (error?: Error) => void): this;
  address(): { address: string; family: string; port: number } | string | null;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type Question =
  | { type: 'noul'; instructions: JSONValue; criteria?: { true?: JSONValue; false?: JSONValue } }
  | { type: 'choice'; instructions: JSONValue; criteria: Record<string, JSONValue> }
  | { type: 'score'; instructions: JSONValue; criteria: JSONValue[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; legend?: Record<string, string>; confidence: number };
export interface JevUsage { input_tokens: number; output_tokens: number }
export interface JevRequest { state: JSONValue; questions: Record<string, Question>; signal?: AbortSignal }
export interface JevResponse { model: string; answers: Record<string, Answer>; usage: JevUsage }
/** Any function with this contract can back the server: the real client, the fake, or your own. */
export type JevProvider = (request: JevRequest) => Promise<JevResponse>;

export const JEV_MODEL: 'jev-1.13.0';
export const JEV_ENDPOINT: 'https://api.typesafe.ai/v1/systemone';
export const INPUT_USD_PER_MILLION_TOKENS: 0.042;
export const DEFAULT_STATE_TOKEN_BUDGET: 24000;

export class JevError extends Error {
  readonly name: 'JevError';
  status: number | null;
  code: string;
  constructor(message: string, options?: { status?: number | null; code?: string; cause?: unknown });
}
export class RerankValidationError extends Error {
  readonly name: 'RerankValidationError';
  status: number;
  constructor(message: string);
}

export function estimateTokens(value: unknown): number;
export function estimateCostUsd(inputTokens: number): number;
export function validateQuestions(questions: unknown): void;
export function validateResponse(response: unknown, expected: { model: string; questions: Record<string, Question> }): JevResponse;

export interface JevClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  stateTokenBudget?: number;
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
}
export function createJevClient(options?: JevClientOptions): JevProvider;

export type FakeFixtures =
  | { answers: Record<string, Answer>; usage?: JevUsage }
  | ((request: { model: string; state: JSONValue; questions: Record<string, Question> }) => Record<string, Answer> | { answers: Record<string, Answer>; usage?: JevUsage } | Promise<Record<string, Answer> | { answers: Record<string, Answer>; usage?: JevUsage }>);
export function createFakeProvider(fixtures: FakeFixtures, options?: { model?: string }): JevProvider;

export interface Limiter { run<T>(fn: () => Promise<T> | T): Promise<T>; readonly active: number; readonly pending: number }
export function createLimiter(options?: { concurrency?: number; requestsPerMinute?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Limiter;
export interface ScoreCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly size: number;
  get(query: string, document: string): number | undefined;
  set(query: string, document: string, score: number): void;
  clear(): void;
}
export function createScoreCache(options?: { ttlMs?: number; maxEntries?: number; now?: () => number }): ScoreCache;

export const LIMITS: Readonly<{ maxDocuments: 1000; maxDocumentChars: 20000; maxQueryChars: 4000; maxPack: 20 }>;
export const MODEL_ALIASES: readonly string[];
export const RELEVANCE_INSTRUCTIONS: string;
export const RELEVANCE_CRITERIA: Readonly<{ true: string; false: string }>;

export type RerankDocument = string | { text: string; [key: string]: JSONValue } | { [key: string]: JSONValue };
/** Wire request: Cohere v1/v2, Jina and Voyage fields are all accepted on both rerank routes. */
export interface RerankRequestBody {
  model?: string;
  query: string;
  documents: RerankDocument[];
  top_n?: number;
  top_k?: number;
  return_documents?: boolean;
  rank_fields?: string[];
  max_chunks_per_doc?: number;
}
export interface NormalizedDocument { index: number; text: string; truncated: boolean; original: RerankDocument }
export interface NormalizedRerankRequest {
  model: string;
  query: string;
  documents: NormalizedDocument[];
  limit: number | null;
  returnDocuments: boolean;
  shape: 'cohere' | 'voyage';
  warnings: string[];
}
export interface RerankResult { index: number; relevance_score: number; document?: RerankDocument; truncated?: true }
export interface RerankUsage { total_tokens: number; jev_requests: number; unique_documents: number; deduplicated_documents: number; cached_documents: number; scored_documents: number; estimated_cost_usd: number }
export interface RerankMetrics {
  begin(): void;
  finish(result: { status: number; durationSeconds: number; usage?: RerankUsage | null; documents?: number }): void;
  snapshot(): { requests: number; inFlight: number; durationSeconds: number; documents: number; uniqueDocuments: number; deduplicatedDocuments: number; cachedDocuments: number; scoredDocuments: number; jevRequests: number; tokens: number; estimatedCostUsd: number; statuses: Record<string, number> };
  render(): string;
}
export function createMetrics(): RerankMetrics;
export interface CohereRerankResponse {
  id: string;
  results: RerankResult[];
  model: string;
  served_by: string;
  usage: RerankUsage & { prompt_tokens: number };
  meta: { api_version: { version: '2' }; billed_units: { search_units: 1 }; warnings?: string[] };
}
export interface VoyageRerankResponse { object: 'list'; data: RerankResult[]; model: string; served_by: string; usage: RerankUsage; warnings?: string[] }
export type RerankResponse = CohereRerankResponse | VoyageRerankResponse;

export function normalizeRerankRequest(body: unknown): NormalizedRerankRequest;
export function buildPairwiseRequest(query: string, passage: string): { state: { query: string; passage: string }; questions: Record<'relevant', Question> };
export function buildPackedRequest(query: string, passages: string[]): { state: { query: string; passages: Record<string, string> }; questions: Record<string, Question> };
export function validatePack(pack: number): number;
export interface ScoreUsage extends JevUsage { requests: number; unique_documents: number; deduplicated_documents: number; cached_documents: number; scored_documents: number }
export function scoreDocuments(options: { provider: JevProvider; query: string; texts: string[]; pack?: number; limiter?: Limiter; signal?: AbortSignal; cache?: ScoreCache }): Promise<{ scores: number[]; usage: ScoreUsage }>;
export function rankResults(documents: NormalizedDocument[], scores: number[]): { index: number; relevance_score: number; truncated: boolean }[];
export function buildRerankResponse(normalized: NormalizedRerankRequest, scores: number[], usage: ScoreUsage): RerankResponse;
export function rerank(body: unknown, options: { provider: JevProvider; pack?: number; limiter?: Limiter; signal?: AbortSignal; cache?: ScoreCache }): Promise<RerankResponse>;

export function syntheticRelevance(query: string, passage: string): number;
export function answerRerankQuestions(state: { query: string; passage?: string; passages?: Record<string, string> }, questions: Record<string, Question>, relevance?: (query: string, passage: string) => number): Record<string, Answer>;
export function createSyntheticRerankProvider(options?: { relevance?: (query: string, passage: string) => number; inputTokensPerRequest?: number }): JevProvider;

export interface RerankServerOptions {
  provider: JevProvider;
  token?: string | null;
  pack?: number;
  limiter?: Limiter;
  cache?: ScoreCache;
  metrics?: RerankMetrics;
  log?: (message: string) => void;
  maxBodyBytes?: number;
}
export function createRerankServer(options: RerankServerOptions): RerankServer;
export function describeError(error: unknown): { status: number; message: string };
