import type { QueryClient } from "@tanstack/react-query";
import type { Me } from "../api/auth";
import { orgQuery } from "../api/orgs";
import { NAV_ITEMS } from "../features/nav";
import { appsQuery } from "../features/plugins/apps/api";
import { currentOrgOf, orgPermissionsOf } from "../org/useOrg";
import { pinsQuery } from "./homeApi";

/**
 * The longest a page load waits for the navigation's data. A slow answer past it fills in later,
 * its row held by a placeholder (AppShell.tsx, GrantedNavEntry).
 */
export const PRIME_LIMIT_MS = 2_000;

/**
 * Loads what the sidebar decides on (the permissions in the current organization, the entries
 * that depend on an area's status or grants, the apps and the pins) before the shell first
 * renders, so a full page load draws the final navigation from the first frame instead of entries
 * popping in and moving the others. The boot state of index.html covers the wait.
 *
 * Only what is not cached yet is asked (`ensureQueryData`): a later page change finds it all and
 * goes on at once. A failed request is left to the hook that reads it, as without priming.
 */
export async function primeShell(
  queryClient: QueryClient,
  me: Me,
  limitMs = PRIME_LIMIT_MS,
): Promise<void> {
  const org = currentOrgOf(me);
  if (org === undefined) {
    return;
  }
  const orgId = org.id;
  const work = (async () => {
    // Asked at once, beside the permissions: neither depends on them.
    const independent = Promise.allSettled([
      queryClient.ensureQueryData(pinsQuery(orgId)),
      queryClient.ensureQueryData(appsQuery(orgId)),
    ]);
    const details = await queryClient.ensureQueryData(orgQuery(orgId));
    const permissions = orgPermissionsOf(details.permissions, me.isServerAdmin, true);
    await Promise.allSettled([
      independent,
      ...NAV_ITEMS.map((item) => item.prime?.(queryClient, orgId, permissions)),
    ]);
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  await Promise.race([work, limit]);
  clearTimeout(timer);
}
