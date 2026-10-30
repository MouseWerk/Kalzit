import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "../../api/generated/shapes";
import type { MessageKey } from "../../i18n/i18n";
import { type OrgPermissions, useCurrentOrg, useOrgPermissions } from "../../org/useOrg";

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

/**
 * The address of a settings section, for the links of the administration that lead there. The
 * section is a parameter of the settings route, which these links' type does not take.
 */
function settingsSection(section: "appearance" | "organization"): NonNullable<LinkProps["to"]> {
  return `/settings/${section}` as NonNullable<LinkProps["to"]>;
}

export interface AdminSectionLink {
  to: NonNullable<LinkProps["to"]>;
  label: MessageKey;
  description: MessageKey;
  /**
   * Who may open the section. Takes the organization permissions, so the main navigation (which
   * lists the sections as sub-pages) and the overview, with its AdminAccess, share one rule.
   */
  visible: (access: OrgPermissions) => boolean;
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
    to: settingsSection("organization"),
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
  {
    to: "/admin/usage",
    label: "usage.title",
    description: "usage.lead",
    // Server administrators find the same page under Server, where it covers every organization.
    visible: (access) => access.has("audit:read") && !access.isServerAdmin,
  },
];

/** The usage page in the server group: every organization, or one chosen there. */
const SERVER_USAGE: AdminSectionLink = {
  to: "/admin/usage",
  label: "usage.title",
  description: "usage.lead",
  visible: (access) => access.isServerAdmin,
};

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
    to: settingsSection("appearance"),
    label: "admin.serverSettings.title",
    description: "admin.serverSettings.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/updates",
    label: "admin.updates.title",
    description: "admin.updates.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/instances",
    label: "admin.instances.title",
    description: "admin.instances.lead",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/audit",
    label: "admin.serverAudit.title",
    description: "admin.serverAudit.lead",
    visible: (access) => access.isServerAdmin,
  },
  SERVER_USAGE,
];
