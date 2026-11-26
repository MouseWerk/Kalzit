/**
 * The numbers on the administration's overview (docs/api/access.md, "Administration overview").
 * A number is present only when the caller may open its section.
 */
import { expectShape, isRecord, request } from "../../api/client";

export interface AdminSummary {
  members?: number;
  teams?: number;
  roles?: number;
  serviceAccounts?: number;
  users?: number;
  orgs?: number;
}

function isSummary(value: unknown): value is AdminSummary {
  return (
    isRecord(value) &&
    Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
}

export const summaryKey = (orgId: string) => ["admin", "org", orgId, "summary"] as const;

export async function getAdminSummary(orgId: string): Promise<AdminSummary> {
  return expectShape(
    await request("GET", `/api/orgs/${encodeURIComponent(orgId)}/admin/summary`),
    isSummary,
    "administration summary",
  );
}
