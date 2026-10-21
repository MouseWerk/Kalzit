import type { Permission } from "../../api/generated/shapes";
import type { OrgPermissions } from "../../org/useOrg";

/**
 * Permissions that make someone an organization admin for the purpose of the administration
 * area (owner decision). users:read alone does not count: editors hold it to share dashboards.
 */
export const ADMINISTRATION_PERMISSIONS = [
  "users:write",
  "settings:read",
  "roles:write",
  "audit:read",
] as const satisfies readonly Permission[];

/**
 * Who sees the administration: server admins and organization admins. The server checks every
 * request on its own; this only hides the entry.
 */
export function canOpenAdministration(permissions: OrgPermissions): boolean {
  return (
    permissions.isServerAdmin ||
    ADMINISTRATION_PERMISSIONS.some((permission) => permissions.has(permission))
  );
}
