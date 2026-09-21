// Purpose: Download BEIR SciFact, build a BM25 candidate set and reproducibly measure Jev reranking quality, latency and cost.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { createJevClient, rerank } from '../src/index.mjs';

const DATASET_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip';
const DATASET_SHA256 = '536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165';
const CACHE_PATH = resolve('.cache/scifact.zip');

function parseArgs(argv) {
  const options = { limit: 25, candidates: 20, topK: 10, pack: 1, seed: 42, offline: false, output: null };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--offline') options.offline = true;
    else if (['--limit', '--candidates', '--top-k', '--pack', '--seed', '--output'].includes(flag)) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      const key = { '--limit': 'limit', '--candidates': 'candidates', '--top-k': 'topK', '--pack': 'pack', '--seed': 'seed', '--output': 'output' }[flag];
      options[key] = key === 'output' ? value : Number(value);
    } else throw new Error(`Unknown option ${flag}`);
  }
  for (const key of ['limit', 'candidates', 'topK', 'pack']) {
    if (!(Number.isInteger(options[key]) && options[key] > 0)) throw new Error(`${key} must be a positive integer`);
  }
  if (options.topK > options.candidates) throw new Error('top-k cannot exceed candidates');
  return options;
}

async function downloadDataset() {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  let bytes;
  try {
    bytes = await readFile(CACHE_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(DATASET_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`SciFact download failed with HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(CACHE_PATH, bytes);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== DATASET_SHA256) throw new Error(`SciFact archive checksum changed: expected ${DATASET_SHA256}, received ${digest}`);
  return unzipSync(bytes);
}

function decodeEntry(archive, suffix) {
  const key = Object.keys(archive).find(name => name.endsWith(suffix));
  if (!key) throw new Error(`SciFact archive is missing ${suffix}`);
  return new TextDecoder().decode(archive[key]);
}

function jsonLines(text) {
  return text.trim().split(/\r?\n/).map(line => JSON.parse(line));
}

function loadDataset(archive) {
  const corpus = jsonLines(decodeEntry(archive, '/corpus.jsonl')).map(item => ({ id: String(item._id), text: [item.title, item.text].filter(Boolean).join('\n') }));
  const queries = new Map(jsonLines(decodeEntry(archive, '/queries.jsonl')).map(item => [String(item._id), item.text]));
  const lines = decodeEntry(archive, '/qrels/test.tsv').trim().split(/\r?\n/).slice(1);
  const qrels = new Map();
  for (const line of lines) {
    const [queryId, corpusId, scoreText] = line.split('\t');
    const score = Number(scoreText);
    if (score <= 0) continue;
    if (!qrels.has(queryId)) qrels.set(queryId, new Map());
    qrels.get(queryId).set(corpusId, score);
  }
  return { corpus, queries, qrels };
}

const tokens = text => String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];

function buildBm25(corpus) {
  const lengths = [];
  const termFrequencies = [];
  const documentFrequency = new Map();
  for (const document of corpus) {
    const counts = new Map();
    const words = tokens(document.text);
    lengths.push(words.length);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    termFrequencies.push(counts);
    for (const word of counts.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
  }
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  return query => {
    const queryTerms = [...new Set(tokens(query))];
    return corpus.map((document, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = termFrequencies[index].get(term) ?? 0;
        if (!frequency) continue;
        const docsWithTerm = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (corpus.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
        score += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * lengths[index] / averageLength)));
      }
      return { id: document.id, index, score };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  };
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function selectQueries(qrels, limit, seed) {
  const random = mulberry32(seed);
  return [...qrels.keys()].sort().map(id => ({ id, order: random() })).sort((a, b) => a.order - b.order).slice(0, limit).map(item => item.id);
}

function dcg(ids, relevant, k) {
  return ids.slice(0, k).reduce((sum, id, index) => sum + ((2 ** (relevant.get(id) ?? 0) - 1) / Math.log2(index + 2)), 0);
}

function metrics(ids, relevant, k) {
  const ideal = [...relevant.values()].sort((a, b) => b - a);
  const idealDcg = ideal.slice(0, k).reduce((sum, score, index) => sum + ((2 ** score - 1) / Math.log2(index + 2)), 0);
  const first = ids.slice(0, k).findIndex(id => relevant.has(id));
  const found = new Set(ids.slice(0, k).filter(id => relevant.has(id))).size;
  return { ndcg: idealDcg ? dcg(ids, relevant, k) / idealDcg : 0, mrr: first === -1 ? 0 : 1 / (first + 1), recall: relevant.size ? found / relevant.size : 0 };
}

const round = value => Math.round(value * 1_000_000) / 1_000_000;
function average(rows, key) { return round(rows.reduce((sum, row) => sum + row[key], 0) / rows.length); }

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.offline && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required unless --offline is used');
  const dataset = loadDataset(await downloadDataset());
  const search = buildBm25(dataset.corpus);
  const provider = options.offline ? null : createJevClient({ maxRetries: 2 });
  const queryIds = selectQueries(dataset.qrels, Math.min(options.limit, dataset.qrels.size), options.seed);
  const rows = [];
  const usage = { input_tokens: 0, output_tokens: 0, jev_requests: 0, estimated_cost_usd: 0 };
  const startedAt = new Date().toISOString();
  const started = Date.now();
  for (const [position, queryId] of queryIds.entries()) {
    const query = dataset.queries.get(queryId);
    const candidates = search(query).slice(0, options.candidates);
    const baselineIds = candidates.map(item => item.id);
    let rerankedIds = baselineIds;
    if (provider) {
      const response = await rerank({ query, documents: candidates.map(item => dataset.corpus[item.index].text), top_n: candidates.length }, { provider, pack: options.pack });
      rerankedIds = response.results.map(item => candidates[item.index].id);
      usage.input_tokens += response.usage.prompt_tokens;
      usage.output_tokens += response.usage.total_tokens - response.usage.prompt_tokens;
      usage.jev_requests += response.usage.jev_requests;
      usage.estimated_cost_usd += response.usage.estimated_cost_usd;
    }
    const relevant = dataset.qrels.get(queryId);
    rows.push({ query_id: queryId, query, baseline: metrics(baselineIds, relevant, options.topK), ...(provider ? { jev: metrics(rerankedIds, relevant, options.topK) } : {}), candidate_recall: metrics(baselineIds, relevant, options.candidates).recall });
    process.stderr.write(`\r${position + 1}/${queryIds.length} queries`);
  }
  process.stderr.write('\n');
  const summary = {
    dataset: 'BEIR SciFact test', dataset_url: DATASET_URL, started_at: startedAt, elapsed_ms: Date.now() - started,
    options, query_ids: queryIds,
    bm25: { ndcg_at_k: average(rows.map(row => row.baseline), 'ndcg'), mrr_at_k: average(rows.map(row => row.baseline), 'mrr'), recall_at_k: average(rows.map(row => row.baseline), 'recall') },
    candidate_recall: average(rows, 'candidate_recall'),
    ...(provider ? { jev: { ndcg_at_k: average(rows.map(row => row.jev), 'ndcg'), mrr_at_k: average(rows.map(row => row.jev), 'mrr'), recall_at_k: average(rows.map(row => row.jev), 'recall') }, usage: { ...usage, estimated_cost_usd: round(usage.estimated_cost_usd) } } : {}),
  };
  const output = { description: 'Reproducible rerank benchmark; BM25 retrieves the candidate set, Jev only reorders it.', summary, queries: rows };
  const outputPath = resolve(options.output ?? `benchmarks/results/scifact-${options.offline ? 'bm25' : 'jev'}-${queryIds.length}.local.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ output: outputPath, ...summary }, null, 2));
}

main().catch(error => { console.error(`benchmark: ${error.message}`); process.exitCode = 1; });
