import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord, request } from "./client";

/** `GET /api/orgs/{orgId}`: the organization as the signed-in member sees it. */
export interface OrgDetails {
  id: string;
  name: string;
  /** A built-in role (owner, admin, editor, viewer) or the name of a custom role. */
  role: string;
  /** Effective permissions in this organization, such as `users:read` (docs/ARCHITECTURE.md). */
  permissions: string[];
}

export function isOrgDetails(value: unknown): value is OrgDetails {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.role === "string" &&
    Array.isArray(value.permissions) &&
    value.permissions.every((permission) => typeof permission === "string")
  );
}

export async function fetchOrg(orgId: string): Promise<OrgDetails> {
  const path = `/api/orgs/${encodeURIComponent(orgId)}`;
  return expectShape(await request("GET", path), isOrgDetails, "organization");
}

export const ORG_QUERY_KEY = "org";

export function orgQuery(orgId: string) {
  return queryOptions({
    queryKey: [ORG_QUERY_KEY, orgId],
    queryFn: () => fetchOrg(orgId),
    staleTime: 60_000,
  });
}
