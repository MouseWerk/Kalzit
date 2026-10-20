import type { OrgPermissions } from "../../org/useOrg";

/**
 * Who sees the administration: server admins, and members allowed to read the organization's
 * users or settings. The server checks every request on its own; this only hides the entry.
 */
export function canOpenAdministration(permissions: OrgPermissions): boolean {
  return (
    permissions.isServerAdmin || permissions.has("users:read") || permissions.has("settings:read")
  );
}
