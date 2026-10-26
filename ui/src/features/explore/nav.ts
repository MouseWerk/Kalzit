import { useQuery } from "@tanstack/react-query";
import { useCurrentOrg } from "../../org/useOrg";
import type { NavItem } from "../../shell/navItem";
import { datasourcesQuery } from "../datasources/api";

/**
 * Whether a source in the list may be queried by a grant (`access.query`). Shares the cache of
 * the Explore picker, so opening Explore after it loads nothing again.
 */
function useQueryGrant(): boolean {
  const org = useCurrentOrg();
  const sources = useQuery({
    ...datasourcesQuery(org?.id ?? ""),
    enabled: org !== undefined,
  });
  return sources.data?.some((source) => source.access?.query === true) ?? false;
}

/**
 * Explore runs free queries, which need `datasources:query`: org-wide through the role, or on
 * one source through a grant.
 */
export const exploreNav: NavItem = {
  to: "/explore",
  label: "explore.nav",
  icon: "explore",
  visible: (permissions) => permissions.has("datasources:query"),
  useGranted: useQueryGrant,
  // The saved analyses: a list of their own under Explore (docs/api/analyses.md).
  children: [
    {
      to: "/explore/saved",
      label: "analyses.nav",
      visible: (permissions) => permissions.has("analyses:read"),
    },
  ],
};
