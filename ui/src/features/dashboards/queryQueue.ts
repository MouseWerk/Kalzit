/**
 * A concurrency limit for panel queries. A dashboard with twenty panels would otherwise start
 * twenty requests at once; browsers allow six connections per host over HTTP/1.1, so anything
 * above that only queues inside the browser, where it cannot be cancelled. Waiting here instead
 * means a query whose panel went away (navigation, a new time range) is dropped before it is sent.
 */

/** Matches the browsers' per-host connection limit over HTTP/1.1. */
export const PANEL_QUERY_CONCURRENCY = 6;

interface Waiting {
  start: () => void;
  cancel: () => void;
  signal: AbortSignal | undefined;
}

export interface Limiter {
  run: <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  /** Tasks running now and waiting, for tests and diagnostics. */
  stats: () => { active: number; waiting: number };
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const queue: Waiting[] = [];

  function next() {
    while (active < max && queue.length > 0) {
      const item = queue.shift() as Waiting;
      if (item.signal?.aborted === true) {
        item.cancel();
        continue;
      }
      item.start();
    }
  }

  function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      const item: Waiting = {
        signal,
        start: () => {
          active++;
          signal?.removeEventListener("abort", onAbort);
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        },
        cancel: () => reject(signal?.reason),
      };
      function onAbort() {
        const index = queue.indexOf(item);
        if (index !== -1) {
          queue.splice(index, 1);
          item.cancel();
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(item);
      next();
    });
  }

  return { run, stats: () => ({ active, waiting: queue.length }) };
}

export const panelQueries = createLimiter(PANEL_QUERY_CONCURRENCY);
