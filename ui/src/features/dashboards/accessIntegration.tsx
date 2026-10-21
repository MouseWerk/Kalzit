import { type ComponentType, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { type OrgPermissions, useOrgPermissions } from "../../org/useOrg";

/** A folder, dashboard or data source whose grants the access dialog edits. */
export interface AccessResource {
  kind: "folder" | "dashboard" | "datasource";
  id: string;
  name: string;
}

export interface AccessDialogProps {
  resource: AccessResource;
  onClose: () => void;
}

/*
 * INTEGRATION POINT (stream D). The access dialog for grants on folders, dashboards and data
 * sources is built in `ui/src/features/admin/access/` (`<AccessDialog open onClose resource=
 * {{ type, id, name }} />`). Once both are merged, replace the null below with this adapter:
 *
 *   import { AccessDialog } from "../admin/access";
 *   const ACCESS_DIALOG: ComponentType<AccessDialogProps> | null = ({ resource, onClose }) => (
 *     <AccessDialog
 *       open
 *       onClose={onClose}
 *       resource={{ type: resource.kind, id: resource.id, name: resource.name }}
 *     />
 *   );
 *
 * Until then the button stays hidden instead of offering an action that does nothing.
 */
const ACCESS_DIALOG = null as ComponentType<AccessDialogProps> | null;

/** The permission that lets someone change who may use the resource. */
const MANAGE_PERMISSION = {
  folder: "folders:permissions",
  dashboard: "dashboards:share",
  datasource: "datasources:permissions",
} as const;

/**
 * Whether the button shows: the resource's own `access.permissions` (grants included) when the
 * server sent it, else the organization permission for that kind of resource.
 */
export function mayManageAccess(
  kind: AccessResource["kind"],
  allowed: boolean | undefined,
  permissions: Pick<OrgPermissions, "has">,
): boolean {
  return allowed ?? permissions.has(MANAGE_PERMISSION[kind]);
}

/** "Access…" button that opens the access dialog for one resource. */
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
  const Dialog = ACCESS_DIALOG;
  if (Dialog === null || !mayManageAccess(resource.kind, allowed, permissions)) {
    return null;
  }
  return (
    <>
      <button type="button" className="button button--secondary" onClick={() => setOpen(true)}>
        {t("dashboards.access")}
      </button>
      {open ? <Dialog resource={resource} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
