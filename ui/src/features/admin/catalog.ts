/**
 * Display names for the access model: permissions grouped by area with what each one allows,
 * built-in roles, grant levels, audit actions and settings. Typed against the generated
 * permission and setting lists, so a permission or setting the server adds fails the typecheck
 * until it has a text.
 */
import { ORG_ROLES, type OrgRole } from "../../api/auth";
import type { Permission, SettingKey } from "../../api/generated/shapes";
import { catalogs, type MessageKey, type Translate } from "../../i18n/i18n";
import type { GrantLevel, ResourceType, Role, Setting, SubjectType } from "./api";

export const PERMISSION_TEXT: Record<Permission, MessageKey> = {
  "dashboards:read": "admin.permission.dashboards.read",
  "dashboards:write": "admin.permission.dashboards.write",
  "dashboards:delete": "admin.permission.dashboards.delete",
  "dashboards:share": "admin.permission.dashboards.share",
  "folders:read": "admin.permission.folders.read",
  "folders:write": "admin.permission.folders.write",
  "folders:permissions": "admin.permission.folders.permissions",
  "datasources:query": "admin.permission.datasources.query",
  "datasources:read": "admin.permission.datasources.read",
  "datasources:write": "admin.permission.datasources.write",
  "datasources:permissions": "admin.permission.datasources.permissions",
  "analyses:read": "admin.permission.analyses.read",
  "analyses:write": "admin.permission.analyses.write",
  "data:export": "admin.permission.data.export",
  "annotations:write": "admin.permission.annotations.write",
  "teams:read": "admin.permission.teams.read",
  "teams:write": "admin.permission.teams.write",
  "teams:members": "admin.permission.teams.members",
  "users:read": "admin.permission.users.read",
  "users:invite": "admin.permission.users.invite",
  "users:write": "admin.permission.users.write",
  "roles:read": "admin.permission.roles.read",
  "roles:write": "admin.permission.roles.write",
  "serviceaccounts:write": "admin.permission.serviceaccounts.write",
  "audit:read": "admin.permission.audit.read",
  "plugins:configure": "admin.permission.plugins.configure",
  "settings:read": "admin.permission.settings.read",
  "settings:write": "admin.permission.settings.write",
  "org:write": "admin.permission.org.write",
  "org:delete": "admin.permission.org.delete",
};

export interface PermissionGroup {
  title: MessageKey;
  permissions: readonly Permission[];
}

/** The role editor's grouping; every permission sits in exactly one group (tested). */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    title: "admin.permissionGroup.dashboards",
    permissions: [
      "dashboards:read",
      "dashboards:write",
      "dashboards:delete",
      "dashboards:share",
      "folders:read",
      "folders:write",
      "folders:permissions",
    ],
  },
  {
    title: "admin.permissionGroup.data",
    permissions: [
      "datasources:query",
      "datasources:read",
      "datasources:write",
      "datasources:permissions",
      "analyses:read",
      "analyses:write",
      "data:export",
      "annotations:write",
    ],
  },
  {
    title: "admin.permissionGroup.people",
    permissions: [
      "users:read",
      "users:invite",
      "users:write",
      "teams:read",
      "teams:write",
      "teams:members",
      "roles:read",
      "roles:write",
      "serviceaccounts:write",
    ],
  },
  {
    title: "admin.permissionGroup.organization",
    permissions: [
      "settings:read",
      "settings:write",
      "audit:read",
      "plugins:configure",
      "org:write",
      "org:delete",
    ],
  },
];

export function isKnownPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSION_TEXT, value);
}

const BUILT_IN_ROLE_TEXT: Record<OrgRole, MessageKey> = {
  owner: "admin.role.owner",
  admin: "admin.role.admin",
  editor: "admin.role.editor",
  viewer: "admin.role.viewer",
};

export function isBuiltInRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/**
 * The name to show for a member's or team's role: built-in roles in the user's language, custom
 * roles by their name from the role list, and the raw id when the list is not known.
 */
export function roleLabel(t: Translate, role: string, roles: readonly Role[] | undefined): string {
  if (isBuiltInRole(role)) {
    return t(BUILT_IN_ROLE_TEXT[role]);
  }
  const custom = roles?.find((candidate) => candidate.id === role);
  if (custom === undefined) {
    return role;
  }
  return isBuiltInRole(custom.name) ? t(BUILT_IN_ROLE_TEXT[custom.name]) : custom.name;
}

export const LEVEL_TEXT: Record<GrantLevel, MessageKey> = {
  view: "admin.level.view",
  edit: "admin.level.edit",
  admin: "admin.level.admin",
  query: "admin.level.query",
};

export const RESOURCE_TEXT: Record<ResourceType, MessageKey> = {
  folder: "admin.resource.folder",
  dashboard: "admin.resource.dashboard",
  datasource: "admin.resource.datasource",
};

export const SUBJECT_TEXT: Record<SubjectType, MessageKey> = {
  user: "admin.subject.user",
  team: "admin.subject.team",
  role: "admin.subject.role",
};

function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(catalogs.en, key);
}

/**
 * A readable name for an audit action (`team.created` reads "Team created"). Actions this UI has
 * no text for yet show as they are, so a new action on the server is never hidden.
 */
export function auditActionLabel(t: Translate, action: string): string {
  const key = `admin.auditAction.${action}`;
  return isMessageKey(key) ? t(key) : action;
}

/** The audit actions with a readable name, for the action filter. */
export function knownAuditActions(): string[] {
  const prefix = "admin.auditAction.";
  return Object.keys(catalogs.en)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

/**
 * The catalog key of a setting's label or description (`admin.settings.<key>.label`). Typed
 * against the generated registry keys, so a setting the server adds fails the typecheck until
 * both texts exist.
 */
export function settingMessage(key: SettingKey, part: "label" | "description"): MessageKey {
  return `admin.settings.${key}.${part}`;
}

/** Whether the UI has texts for a setting; a newer server may send keys this UI does not know. */
export function isKnownSetting(key: string): key is SettingKey {
  return isMessageKey(`admin.settings.${key}.label`);
}

export interface SettingText {
  /** Undefined for a setting this UI does not know; the key is then the heading. */
  label: string | undefined;
  description: string;
  /** True when the description is the server's English text, for a setting this UI does not know. */
  fromServer: boolean;
}

/** A setting's label and description in the user's language, the server's text as fallback. */
export function settingText(
  t: Translate,
  setting: Pick<Setting, "key" | "description">,
): SettingText {
  if (isKnownSetting(setting.key)) {
    return {
      label: t(settingMessage(setting.key, "label")),
      description: t(settingMessage(setting.key, "description")),
      fromServer: false,
    };
  }
  return { label: undefined, description: setting.description, fromServer: true };
}

/** A setting's name in notices and dialogs: its label, or the key for a setting not known here. */
export function settingName(t: Translate, key: string): string {
  return isKnownSetting(key) ? t(settingMessage(key, "label")) : key;
}

/**
 * Areas of audit actions. The server filters `action` by prefix, so "team." finds every team
 * change; each area has a readable name.
 */
export const AUDIT_AREAS: Record<string, MessageKey> = {
  "auth.": "admin.auditArea.auth",
  "member.": "admin.auditArea.member",
  "team.": "admin.auditArea.team",
  "role.": "admin.auditArea.role",
  "grant.": "admin.auditArea.grant",
  "user.": "admin.auditArea.user",
  "org.": "admin.auditArea.org",
  "settings.": "admin.auditArea.settings",
  "branding.": "admin.auditArea.branding",
  "folder.": "admin.auditArea.folder",
  "dashboard.": "admin.auditArea.dashboard",
  "analysis.": "admin.auditArea.analysis",
  "datasource.": "admin.auditArea.datasource",
  "annotation.": "admin.auditArea.annotation",
  "library_panel.": "admin.auditArea.library_panel",
  "playlist.": "admin.auditArea.playlist",
  "service_account.": "admin.auditArea.service_account",
  "api_token.": "admin.auditArea.api_token",
  "scim.": "admin.auditArea.scim",
};

/**
 * The built-in roles' permissions as the server pins them (server/src/authz.rs,
 * `BuiltinRole::permissions`), for deciding what a member may change when the role list cannot
 * be read (no `roles:read`).
 */
const VIEWER: Permission[] = ["dashboards:read", "folders:read", "analyses:read", "teams:read"];
const EDITOR: Permission[] = [
  ...VIEWER,
  "dashboards:write",
  "dashboards:delete",
  "dashboards:share",
  "folders:write",
  "datasources:query",
  "datasources:read",
  "analyses:write",
  "data:export",
  "annotations:write",
  "users:read",
];
const ADMIN: Permission[] = [
  ...EDITOR,
  "folders:permissions",
  "datasources:write",
  "datasources:permissions",
  "teams:write",
  "teams:members",
  "users:invite",
  "users:write",
  "roles:read",
  "roles:write",
  "serviceaccounts:write",
  "audit:read",
  "plugins:configure",
  "settings:read",
  "settings:write",
  "org:write",
];
export const BUILT_IN_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  viewer: VIEWER,
  editor: EDITOR,
  admin: ADMIN,
  owner: [...ADMIN, "org:delete"],
};

/** Permissions only the built-in owner role has; custom roles cannot hold them. */
export const OWNER_ONLY: readonly Permission[] = ["org:delete"];

/**
 * The permissions of a role key, from the role list when known, else for built-in roles from the
 * pinned table; undefined for a custom role the UI cannot read.
 */
export function permissionsOfRole(
  role: string,
  roles: readonly Role[] | undefined,
): readonly string[] | undefined {
  const listed = roles?.find((candidate) => candidate.id === role);
  if (listed !== undefined) {
    return listed.permissions;
  }
  return isBuiltInRole(role) ? BUILT_IN_ROLE_PERMISSIONS[role] : undefined;
}

/**
 * Whether someone holding `has` holds every one of `permissions`. The server refuses giving or
 * taking away what the caller does not hold (docs/api/access.md, "The guards").
 */
export function holdsAll(
  has: (permission: Permission) => boolean,
  permissions: readonly string[] | undefined,
): boolean {
  return (
    permissions?.every((permission) => isKnownPermission(permission) && has(permission)) === true
  );
}
