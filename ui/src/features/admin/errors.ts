import { type ErrorCode, isApiError } from "../../api/client";
import type { MessageKey, Translate } from "../../i18n/i18n";

/**
 * Texts that say more than the generic one, in the context of one action: by code, or by code and
 * the request field the server names (`"conflict:name"` is a taken name, plain `"conflict"` the
 * rest). The field-specific text wins.
 */
export type ErrorTexts = Partial<Record<ErrorCode | `${ErrorCode}:${string}`, MessageKey>>;

export function errorCodeOf(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

/**
 * The text for a failed request. The server answers the protection rules (the last owner, the
 * last server admin, giving or taking more than one holds) with `conflict` or `forbidden`; the
 * caller knows which action failed and passes the readable text for it.
 */
export function errorText(t: Translate, error: unknown, texts: ErrorTexts = {}): string {
  const code = errorCodeOf(error);
  const field = isApiError(error) ? error.field : undefined;
  const specific = field === undefined ? undefined : texts[`${code}:${field}`];
  return t(specific ?? texts[code] ?? `errors.${code}`);
}

/** Changing or removing a member: the last owner stays, and nobody acts beyond what they hold. */
export const MEMBER_ERRORS: ErrorTexts = {
  conflict: "admin.members.lastOwner",
  forbidden: "admin.members.exceedsYou",
};

/** Adding a member by email address. */
export const ADD_MEMBER_ERRORS: ErrorTexts = {
  "validation:email": "admin.members.noAccount",
  "validation:role": "admin.members.unknownRole",
  "conflict:email": "admin.members.alreadyMember",
  conflict: "admin.members.alreadyMember",
  forbidden: "admin.members.cannotGrant",
};

/** Teams: names, and the team's roles that the caller must hold. */
export const TEAM_ERRORS: ErrorTexts = {
  "conflict:name": "admin.teams.nameTaken",
  "validation:roles": "admin.teams.rolesInvalid",
  forbidden: "admin.teams.rolesExceedYou",
};

/** Roles: names, the role limit, and permissions the caller does not hold. */
export const ROLE_ERRORS: ErrorTexts = {
  "conflict:name": "admin.roles.nameTaken",
  "validation:name": "admin.roles.nameNotAllowed",
  conflict: "admin.roles.limit",
  forbidden: "admin.roles.cannotGrant",
};

/** Demoting or locking a server admin: the last one stays. */
export const SERVER_ADMIN_ERRORS: ErrorTexts = {
  conflict: "admin.users.lastServerAdmin",
  "conflict:email": "admin.users.emailTaken",
};

/**
 * Locking an account: refused for the last active server admin and for the last enabled owner
 * of an organization; the answer does not say which, so the text names both.
 */
export const LOCK_ERRORS: ErrorTexts = {
  conflict: "admin.users.cannotLock",
};

/** Granting access with a level beyond what the caller holds on the resource. */
export const GRANT_ERRORS: ErrorTexts = {
  forbidden: "admin.access.cannotGrant",
};

/** Changing a setting the environment or file sets, or a value the server rejects. */
export const SETTING_ERRORS: ErrorTexts = {
  conflict: "admin.settings.notEditable",
  "validation:value": "admin.settings.rejected",
};
