import { useQuery } from "@tanstack/react-query";
import { ORG_ROLES } from "../../../api/auth";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listRoles, type Role } from "../api";
import { holdsAll, permissionsOfRole, roleLabel } from "../catalog";
import type { AdminAccess } from "../sections";

/** The organization's roles, built-in and custom, when the user may read them. */
export function useRoles(orgId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: adminKeys.roles(orgId ?? ""),
    queryFn: () => listRoles(orgId ?? ""),
    enabled: orgId !== undefined && enabled,
  });
}

/**
 * Whether the user holds every permission of a role key. Nobody gives or takes away more than
 * they hold (docs/api/access.md, "The guards"): the server refuses it, the UI only offers what it
 * would accept. A custom role the UI cannot read counts as not held.
 */
export function holdsRole(
  access: AdminAccess,
  role: string,
  roles: readonly Role[] | undefined,
): boolean {
  return holdsAll(access.has, permissionsOfRole(role, roles));
}

/**
 * A role picker. With the role list it offers custom roles too; without it (no `roles:read`) only
 * the built-in roles. Roles the user does not hold are disabled. `pending` keeps the control
 * focusable while a change is on its way, but ignores further changes.
 */
export function RoleSelect({
  label,
  value,
  onChange,
  roles,
  access,
  pending = false,
  id,
}: {
  label?: string;
  value: string;
  onChange: (role: string) => void;
  roles: readonly Role[] | undefined;
  access: AdminAccess;
  pending?: boolean;
  id?: string;
}) {
  const { t } = useI18n();
  const keys: string[] = roles === undefined ? [...ORG_ROLES] : roles.map((role) => role.id);
  // A member may hold a role the list does not know (yet); keep it shown as it is.
  if (!keys.includes(value)) {
    keys.unshift(value);
  }
  return (
    <select
      id={id}
      className="select"
      aria-label={label}
      aria-disabled={pending}
      value={value}
      onChange={(event) => {
        if (!pending) {
          onChange(event.currentTarget.value);
        }
      }}
    >
      {keys.map((key) => (
        <option key={key} value={key} disabled={key !== value && !holdsRole(access, key, roles)}>
          {roleLabel(t, key, roles)}
        </option>
      ))}
    </select>
  );
}
