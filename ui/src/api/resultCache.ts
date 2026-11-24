import {
  hashKey,
  type QueryClient,
  type QueryKey,
  QueryObserver,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * How long a query result (a panel's answer, an Explore run) stays in the cache once nothing
 * shows it. Short: one answer may hold up to the server's response size limit, and every
 * refresh, time range or run makes a new one.
 */
export const RESULT_GC_MS = 5_000;

/**
 * Drops the cached answers under `prefix` that nothing shows anymore, except the one of `keep`,
 * so a panel or Explore keeps only its latest answer instead of one per refresh or run. A query
 * still shown elsewhere is left alone; the answer on screen while the new one loads lives in its
 * observer, not in the cache.
 */
export function dropOlderResults(client: QueryClient, prefix: QueryKey, keep: QueryKey) {
  const cache = client.getQueryCache();
  const kept = hashKey(keep);
  for (const query of cache.findAll({ queryKey: prefix })) {
    if (query.queryHash !== kept && query.getObserversCount() === 0) {
      cache.remove(query);
    }
  }
}

/**
 * Keeps the cached answers under `prefix` while `hold` is on, though nothing shows them: the
 * dashboard's panels while the panel editor or the settings page stands in their place. Back on
 * the dashboard each panel finds its answer and draws it at once; only a panel whose question
 * changed (the one edited) asks again. Answers that arrive meanwhile are not held.
 */
export function useHeldResults(hold: boolean, prefix: QueryKey): void {
  const client = useQueryClient();
  const key = hashKey(prefix);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the prefix
  useEffect(() => {
    if (!hold) {
      return;
    }
    const held = client
      .getQueryCache()
      .findAll({ queryKey: prefix })
      .filter((query) => query.state.data !== undefined)
      .map((query) =>
        // A silent observer: it never runs the query, it only keeps it from being collected.
        new QueryObserver(client, {
          queryKey: query.queryKey,
          enabled: false,
          gcTime: RESULT_GC_MS,
        }).subscribe(() => undefined),
      );
    return () => {
      for (const release of held) release();
    };
  }, [hold, client, key]);
}
