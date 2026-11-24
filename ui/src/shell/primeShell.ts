import type { EnsureQueryDataOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import type { Me } from "../api/auth";
import { orgQuery } from "../api/orgs";
import { NAV_ITEMS } from "../features/nav";
import { appsQuery } from "../features/plugins/apps/api";
import { currentOrgOf, orgPermissionsOf } from "../org/useOrg";
import { pinsQuery } from "./homeApi";
import { markPrimed } from "./primedOrgs";

/**
 * The longest a page load waits for the navigation's data. A slow answer past it fills in later,
 * its row held by a placeholder (AppShell.tsx, GrantedNavEntry).
 */
export const PRIME_LIMIT_MS = 2_000;

/**
 * Puts one query's data into the cache for the first frame: once, without retries, and not at all
 * when the query already failed (its hook asks again, with retries, as without priming).
 */
export type PrimeQuery = <TData, TKey extends QueryKey>(
  options: EnsureQueryDataOptions<TData, Error, TData, TKey>,
) => Promise<unknown>;

/** `PrimeQuery` on `queryClient`. */
export function primeQuery(queryClient: QueryClient): PrimeQuery {
  return (options) => {
    if (queryClient.getQueryState(options.queryKey)?.status === "error") {
      return Promise.resolve();
    }
    return queryClient.ensureQueryData({ ...options, retry: false });
  };
}

/**
 * Loads what the sidebar decides on (the permissions in the current organization, the entries
 * that depend on an area's status or grants, the apps and the pins) before the shell first
 * renders, so a full page load draws the final navigation from the first frame instead of entries
 * popping in and moving the others. The boot state of index.html covers the wait.
 *
 * Only the first page of a signed-in account in an organization waits for it (`primedOrgs`):
 * a later page change goes on at once, also while a request of the sidebar keeps failing.
 */
export async function primeShell(
  queryClient: QueryClient,
  me: Me,
  limitMs = PRIME_LIMIT_MS,
): Promise<void> {
  const org = currentOrgOf(me);
  if (org === undefined || !markPrimed(me.id, org.id)) {
    return;
  }
  const orgId = org.id;
  const ensure = primeQuery(queryClient);
  const work = (async () => {
    // Asked at once, beside the permissions: neither depends on them.
    const independent = Promise.allSettled([ensure(pinsQuery(orgId)), ensure(appsQuery(orgId))]);
    await ensure(orgQuery(orgId));
    const details = queryClient.getQueryData(orgQuery(orgId).queryKey);
    if (details === undefined) {
      return;
    }
    const permissions = orgPermissionsOf(details.permissions, me.isServerAdmin, true);
    await Promise.allSettled([
      independent,
      ...NAV_ITEMS.map((item) => item.prime?.(ensure, orgId, permissions)),
    ]);
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  await Promise.race([work, limit]);
  clearTimeout(timer);
}
