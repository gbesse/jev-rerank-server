// Purpose: Optional bounded in-memory TTL cache for exact (query, rendered document) rerank scores.

function positiveInteger(value, name, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!(Number.isInteger(value) && value >= minimum)) throw new RangeError(`${name} must be an integer >= ${minimum}`);
  return value;
}

/**
 * Build an exact-input LRU cache. It is deliberately process-local and disabled unless callers create and inject it.
 * Model errors are never cached; callers commit scores only after the complete rerank request succeeds.
 */
export function createScoreCache({ ttlMs = 300_000, maxEntries = 5000, now = Date.now } = {}) {
  positiveInteger(ttlMs, 'ttlMs');
  positiveInteger(maxEntries, 'maxEntries');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const entries = new Map();
  const keyFor = (query, document) => JSON.stringify([query, document]);

  return Object.freeze({
    ttlMs,
    maxEntries,
    get size() { return entries.size; },
    get(query, document) {
      const key = keyFor(query, document);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Map insertion order is the LRU order. Refresh position, never expiry.
      entries.delete(key);
      entries.set(key, entry);
      return entry.score;
    },
    set(query, document, score) {
      if (!(Number.isFinite(score) && score >= 0 && score <= 1)) throw new RangeError('score must be finite and in [0,1]');
      const key = keyFor(query, document);
      entries.delete(key);
      entries.set(key, { score, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); },
  });
}
