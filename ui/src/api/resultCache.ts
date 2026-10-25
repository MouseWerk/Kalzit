import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

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
