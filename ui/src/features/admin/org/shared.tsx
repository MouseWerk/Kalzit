import { useQuery } from "@tanstack/react-query";
import { ORG_ROLES } from "../../../api/auth";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listRoles, type Role } from "../api";
import { isKnownPermission, roleLabel } from "../catalog";
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
 * Whether the user holds every permission of a role. Nobody can grant more than they hold
 * (docs/ARCHITECTURE.md); the server refuses it, the UI only offers what it would accept.
 */
export function canGrant(access: AdminAccess, role: Role): boolean {
  return role.permissions.every(
    (permission) => isKnownPermission(permission) && access.has(permission),
  );
}

/**
 * A role picker. With the role list it offers custom roles too and disables roles the user may
 * not grant; without it (no `roles:read`) it offers the built-in roles.
 */
export function RoleSelect({
  label,
  value,
  onChange,
  roles,
  access,
  disabled = false,
  id,
}: {
  label?: string;
  value: string;
  onChange: (role: string) => void;
  roles: readonly Role[] | undefined;
  access: AdminAccess;
  disabled?: boolean;
  id?: string;
}) {
  const { t } = useI18n();
  const options =
    roles === undefined
      ? ORG_ROLES.map((role) => ({ id: role, allowed: true }))
      : roles.map((role) => ({ id: role.id, allowed: canGrant(access, role) }));
  // A member may hold a role the list does not know (yet); keep it selectable as it is.
  if (!options.some((option) => option.id === value)) {
    options.unshift({ id: value, allowed: true });
  }
  return (
    <select
      id={id}
      className="select"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id} disabled={!option.allowed && option.id !== value}>
          {roleLabel(t, option.id, roles)}
        </option>
      ))}
    </select>
  );
}
