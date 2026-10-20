import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "../../api/generated/shapes";
import type { MessageKey } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";

export interface AdminAccess {
  /** The organization the sections work on; undefined for a server admin without one. */
  orgId: string | undefined;
  orgName: string | undefined;
  /** True when the permission is granted in the current organization. */
  has: (permission: Permission) => boolean;
  isServerAdmin: boolean;
  loaded: boolean;
}

/**
 * What the signed-in user may do in the administration. Only for hiding: the server checks
 * every request on its own.
 */
export function useAdminAccess(): AdminAccess {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  return {
    orgId: org?.id,
    orgName: org?.name,
    has: (permission) => org !== undefined && permissions.has(permission),
    isServerAdmin: permissions.isServerAdmin,
    loaded: permissions.loaded,
  };
}

/** `allowed` for a section: undefined while loading, so nothing flashes. */
export function allowedWhen(access: AdminAccess, allowed: boolean): boolean | undefined {
  return access.loaded ? allowed : undefined;
}

export interface AdminSectionLink {
  to: NonNullable<LinkProps["to"]>;
  label: MessageKey;
  description: MessageKey;
  visible: (access: AdminAccess) => boolean;
}

export const ORG_SECTIONS: readonly AdminSectionLink[] = [
  {
    to: "/admin/members",
    label: "admin.members.title",
    description: "admin.members.lead",
    visible: (access) => access.has("users:read"),
  },
  {
    to: "/admin/teams",
    label: "admin.teams.title",
    description: "admin.teams.lead",
    visible: (access) => access.has("teams:read"),
  },
  {
    to: "/admin/roles",
    label: "admin.roles.title",
    description: "admin.roles.lead",
    visible: (access) => access.has("roles:read"),
  },
  {
    to: "/admin/settings",
    label: "admin.orgSettings.title",
    description: "admin.orgSettings.lead",
    visible: (access) => access.has("settings:read"),
  },
  {
    to: "/admin/audit",
    label: "admin.audit.title",
    description: "admin.audit.lead",
    visible: (access) => access.has("audit:read"),
  },
];

export const SERVER_SECTIONS: readonly AdminSectionLink[] = [
  {
    to: "/admin/server/users",
    label: "admin.users.title",
    description: "admin.users.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/organizations",
    label: "admin.orgs.title",
    description: "admin.orgs.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/settings",
    label: "admin.serverSettings.title",
    description: "admin.serverSettings.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/audit",
    label: "admin.serverAudit.title",
    description: "admin.serverAudit.lead",
    visible: (access) => access.isServerAdmin,
  },
];
