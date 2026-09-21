// Purpose: In-process concurrency cap and sliding-window rate limiter shared by every parallel Jev call.
import { setTimeout as delay } from 'node:timers/promises';

/**
 * `run(fn)` executes `fn` once a concurrency slot is free and fewer than `requestsPerMinute` starts happened in the last
 * minute. The defaults stay under Jev's published 1,200 requests/min so a burst of rerank calls backs off locally instead
 * of collecting 429s. `now` and `sleep` are injectable so tests can drive the clock.
 */
export function createLimiter({ concurrency = 8, requestsPerMinute = 1000, now = () => Date.now(), sleep = ms => delay(ms) } = {}) {
  if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 256)) throw new RangeError('concurrency must be an integer between 1 and 256');
  if (!(Number.isInteger(requestsPerMinute) && requestsPerMinute >= 1)) throw new RangeError('requestsPerMinute must be a positive integer');
  const WINDOW_MS = 60_000;
  let active = 0;
  const queue = [];
  const starts = [];

  function pump() {
    while (active < concurrency && queue.length) {
      active++;
      queue.shift()();
    }
  }

  async function waitForRateSlot() {
    for (;;) {
      const current = now();
      while (starts.length && starts[0] <= current - WINDOW_MS) starts.shift();
      if (starts.length < requestsPerMinute) { starts.push(current); return; }
      await sleep(starts[0] + WINDOW_MS - current);
    }
  }

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push(async () => {
          try {
            await waitForRateSlot();
            resolve(await fn());
          } catch (error) {
            reject(error);
          } finally {
            active--;
            pump();
          }
        });
        pump();
      });
    },
    get active() { return active; },
    get pending() { return queue.length; },
  };
}
