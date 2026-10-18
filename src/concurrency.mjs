// Purpose: Shared concurrency/rate admission with removable abandoned queued work.
import { setTimeout as delay } from 'node:timers/promises';

export function createLimiter({ concurrency = 8, requestsPerMinute = 1000, now = () => Date.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 256)) throw new RangeError('concurrency must be an integer between 1 and 256');
  if (!(Number.isInteger(requestsPerMinute) && requestsPerMinute >= 1)) throw new RangeError('requestsPerMinute must be a positive integer');
  const WINDOW_MS = 60_000;
  let active = 0;
  let queue = [];
  const starts = [];
  const watchers = new Map();

  function unwatch(job) {
    const bucket = watchers.get(job.signal);
    if (!bucket) return;
    bucket.jobs.delete(job);
    if (!bucket.jobs.size) { job.signal.removeEventListener('abort', bucket.abort); watchers.delete(job.signal); }
  }
  function watch(job) {
    if (!job.signal) return;
    let bucket = watchers.get(job.signal);
    if (!bucket) {
      bucket = { jobs: new Set(), abort: null };
      bucket.abort = () => {
        queue = queue.filter(item => !bucket.jobs.has(item));
        watchers.delete(job.signal);
        for (const item of bucket.jobs) item.reject(job.signal.reason);
        bucket.jobs.clear();
        pump();
      };
      watchers.set(job.signal, bucket);
      job.signal.addEventListener('abort', bucket.abort, { once: true });
    }
    bucket.jobs.add(job);
  }
  async function pause(ms, signal) {
    if (!signal) return sleep(ms);
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return sleep(ms, signal); }).then(
        value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }
  async function waitForRateSlot(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const current = now();
      while (starts.length && starts[0] <= current - WINDOW_MS) starts.shift();
      if (starts.length < requestsPerMinute) { starts.push(current); return; }
      await pause(starts[0] + WINDOW_MS - current, signal);
    }
  }
  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      unwatch(job);
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      active++;
      (async () => {
        try { await waitForRateSlot(job.signal); job.signal?.throwIfAborted(); job.resolve(await job.fn()); }
        catch (error) { job.reject(error); }
        finally { active--; pump(); }
      })();
    }
  }
  return {
    run(fn, { signal } = {}) {
      if (typeof fn !== 'function') return Promise.reject(new TypeError('Tâche invalide / Invalid task / Tarea no válida'));
      if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new TypeError('Signal invalide / Invalid signal / Señal no válida'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const job = { fn, signal, resolve, reject };
        queue.push(job); watch(job); pump();
      });
    },
    get active() { return active; },
    get pending() { return queue.length; },
  };
}
