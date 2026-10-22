import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { type OrgPermissions, useOrgPermissions } from "../../org/useOrg";
import { AccessDialog, MANAGE_PERMISSION } from "../admin/access";

/** A folder, dashboard or data source whose grants the access dialog edits. */
export interface AccessResource {
  kind: "folder" | "dashboard" | "datasource";
  id: string;
  name: string;
}

/**
 * Whether the button shows: the resource's own `access.permissions` (grants included) when the
 * server sent it, else the organization permission for that kind of resource (`MANAGE_PERMISSION`
 * from the access dialog, so both agree on which permission manages grants).
 */
export function mayManageAccess(
  kind: AccessResource["kind"],
  allowed: boolean | undefined,
  permissions: Pick<OrgPermissions, "has">,
): boolean {
  return allowed ?? permissions.has(MANAGE_PERMISSION[kind]);
}

/** "Access…" button that opens stream D's access dialog for one resource. */
export function AccessButton({
  resource,
  allowed,
}: {
  resource: AccessResource;
  /**
   * Whether the caller may manage grants on this very resource (`access.permissions` in the
   * answer, grants included). Absent: the organization permission decides.
   */
  allowed?: boolean | undefined;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const [open, setOpen] = useState(false);
  if (!mayManageAccess(resource.kind, allowed, permissions)) {
    return null;
  }
  return (
    <>
      <button type="button" className="button button--secondary" onClick={() => setOpen(true)}>
        {t("dashboards.access")}
      </button>
      {open ? (
        <AccessDialog
          open
          onClose={() => setOpen(false)}
          resource={{ type: resource.kind, id: resource.id, name: resource.name }}
        />
      ) : null}
    </>
  );
}
