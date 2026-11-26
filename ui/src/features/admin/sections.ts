import type { LinkProps } from "@tanstack/react-router";
import type { Permission } from "../../api/generated/shapes";
import type { IconName } from "../../components/Icon";
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
  /** The overview's row: an icon, one short line, and the small group it is listed under. */
  icon: IconName;
  summary: MessageKey;
  cluster: MessageKey;
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
    icon: "members",
    summary: "admin.overview.summary.members",
    cluster: "admin.overview.cluster.access",
    visible: (access) => access.has("users:read"),
  },
  {
    to: "/admin/teams",
    label: "admin.teams.title",
    description: "admin.teams.lead",
    icon: "network",
    summary: "admin.overview.summary.teams",
    cluster: "admin.overview.cluster.access",
    visible: (access) => access.has("teams:read"),
  },
  {
    to: "/admin/roles",
    label: "admin.roles.title",
    description: "admin.roles.lead",
    icon: "shieldCheck",
    summary: "admin.overview.summary.roles",
    cluster: "admin.overview.cluster.access",
    visible: (access) => access.has("roles:read"),
  },
  {
    to: "/admin/service-accounts",
    label: "admin.serviceAccounts.title",
    description: "admin.serviceAccounts.lead",
    icon: "robot",
    summary: "admin.overview.summary.serviceAccounts",
    cluster: "admin.overview.cluster.access",
    visible: (access) => access.has("serviceaccounts:write"),
  },
  {
    to: "/admin/shares",
    label: "admin.shares.title",
    description: "admin.shares.lead",
    // The server lists everyone's links and snapshots for organization admins only.
    icon: "share",
    summary: "admin.overview.summary.shares",
    cluster: "admin.overview.cluster.operations",
    visible: (access) => access.has("org:write"),
  },
  {
    to: "/admin/provisioning",
    label: "admin.provisioning.title",
    description: "admin.provisioning.lead",
    icon: "documents",
    summary: "admin.overview.summary.provisioning",
    cluster: "admin.overview.cluster.operations",
    visible: (access) => access.has("provisioning:read"),
  },
  {
    to: settingsSection("organization"),
    label: "admin.orgSettings.title",
    description: "admin.orgSettings.lead",
    icon: "settings",
    summary: "admin.overview.summary.orgSettings",
    cluster: "admin.overview.cluster.operations",
    visible: (access) => access.has("settings:read"),
  },
  {
    to: "/admin/audit",
    label: "admin.audit.title",
    description: "admin.audit.lead",
    icon: "history",
    summary: "admin.overview.summary.audit",
    cluster: "admin.overview.cluster.operations",
    visible: (access) => access.has("audit:read"),
  },
  {
    to: "/admin/usage",
    label: "usage.title",
    description: "usage.lead",
    icon: "barChart",
    summary: "admin.overview.summary.usage",
    cluster: "admin.overview.cluster.operations",
    // Server administrators find the same page under Server, where it covers every organization.
    visible: (access) => access.has("audit:read") && !access.isServerAdmin,
  },
];

/** The usage page in the server group: every organization, or one chosen there. */
const SERVER_USAGE: AdminSectionLink = {
  to: "/admin/usage",
  label: "usage.title",
  description: "usage.lead",
  icon: "barChart",
  summary: "admin.overview.summary.usage",
  cluster: "admin.overview.cluster.observe",
  visible: (access) => access.isServerAdmin,
};

export const SERVER_SECTIONS: readonly AdminSectionLink[] = [
  {
    to: "/admin/server/users",
    label: "admin.users.title",
    description: "admin.users.lead",
    icon: "members",
    summary: "admin.overview.summary.users",
    cluster: "admin.overview.cluster.accounts",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/organizations",
    label: "admin.orgs.title",
    description: "admin.orgs.lead",
    icon: "folder",
    summary: "admin.overview.summary.orgs",
    cluster: "admin.overview.cluster.accounts",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: settingsSection("appearance"),
    label: "admin.serverSettings.title",
    description: "admin.serverSettings.lead",
    icon: "settings",
    summary: "admin.overview.summary.serverSettings",
    cluster: "admin.overview.cluster.serverOperations",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/updates",
    label: "admin.updates.title",
    description: "admin.updates.lead",
    icon: "refresh",
    summary: "admin.overview.summary.updates",
    cluster: "admin.overview.cluster.serverOperations",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/instances",
    label: "admin.instances.title",
    description: "admin.instances.lead",
    icon: "screen",
    summary: "admin.overview.summary.instances",
    cluster: "admin.overview.cluster.serverOperations",
    visible: (access) => access.isServerAdmin,
  },
  {
    to: "/admin/server/audit",
    label: "admin.serverAudit.title",
    description: "admin.serverAudit.lead",
    icon: "history",
    summary: "admin.overview.summary.serverAudit",
    cluster: "admin.overview.cluster.observe",
    visible: (access) => access.isServerAdmin,
  },
  SERVER_USAGE,
];
