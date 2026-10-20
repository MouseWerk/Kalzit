import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { Me, OrgMembership } from "../api/auth";
import type { Permission } from "../api/generated/shapes";
import { orgQuery } from "../api/orgs";

const appRoute = getRouteApi("/_app");

/**
 * The organization the UI works in. Until an organization switcher exists, it is the first
 * membership from /api/me; a server admin may belong to none.
 */
export function currentOrgOf(me: Me): OrgMembership | undefined {
  return me.orgs[0];
}

export function useCurrentOrg(): OrgMembership | undefined {
  const { me } = appRoute.useRouteContext();
  return currentOrgOf(me);
}

export interface OrgPermissions {
  /**
   * True when the permission is granted in the current organization. Typed with the generated
   * permission catalog, so a misspelled permission fails the typecheck.
   */
  has: (permission: Permission) => boolean;
  /** Whether the user is a server admin; that is server-wide, not an org permission. */
  isServerAdmin: boolean;
  /** False until the permissions arrived; hide actions until then rather than flash them. */
  loaded: boolean;
}

/**
 * Effective permissions in the current organization, for hiding actions the user cannot take.
 * Only a convenience: the server checks every request on its own.
 */
export function useOrgPermissions(): OrgPermissions {
  const { me } = appRoute.useRouteContext();
  const org = currentOrgOf(me);
  const query = useQuery({
    ...orgQuery(org?.id ?? ""),
    enabled: org !== undefined,
  });
  // Strings, not Permission: the server may grant permissions newer than this UI knows.
  const granted = new Set<string>(query.data?.permissions ?? []);
  return {
    has: (permission) => granted.has(permission),
    isServerAdmin: me.isServerAdmin,
    loaded: org === undefined || query.data !== undefined || query.isError,
  };
}
