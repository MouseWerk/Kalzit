/**
 * Access to single resources, for the areas that own them (folders, dashboards, data sources).
 *
 * ```tsx
 * import { AccessDialog, WhyCanI } from "../admin/access";
 *
 * const [open, setOpen] = useState(false);
 * <button onClick={() => setOpen(true)}>Access…</button>
 * <AccessDialog
 *   open={open}
 *   onClose={() => setOpen(false)}
 *   resource={{ type: "dashboard", id: dashboard.id, name: dashboard.title }}
 * />
 *
 * <WhyCanI permission="dashboards:write" resource={{ type: "dashboard", id: dashboard.id }} />
 * ```
 *
 * - `AccessDialog` lists the grants on the resource and, for members holding the manage
 *   permission (`MANAGE_PERMISSION`: `folders:permissions`, `dashboards:share`,
 *   `datasources:permissions`), adds users, teams or roles with a level and removes them (with
 *   undo). Everyone else sees the list read-only. Focus returns to the opener when it closes.
 * - `WhyCanI` is a small "Why?" button with a popover that lists where a permission comes from.
 * - Both work in the current organization unless `orgId` is given; texts come from the admin
 *   catalog, so the caller passes no labels.
 */

export type { GrantLevel, ResourceType } from "../api";
export {
  AccessDialog,
  type AccessDialogProps,
  type AccessResource,
  MANAGE_PERMISSION,
} from "./AccessDialog";
export { WhyCanI, type WhyCanIProps } from "./WhyCanI";
