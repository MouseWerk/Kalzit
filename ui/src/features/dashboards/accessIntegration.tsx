import { type ComponentType, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";

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

/** "Access…" button that opens the access dialog for one resource. */
export function AccessButton({ resource }: { resource: AccessResource }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const [open, setOpen] = useState(false);
  const Dialog = ACCESS_DIALOG;
  if (Dialog === null || !permissions.has(MANAGE_PERMISSION[resource.kind])) {
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
