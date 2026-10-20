import { type ErrorCode, isApiError } from "../../api/client";
import type { MessageKey, Translate } from "../../i18n/i18n";

/** Texts that say more than the generic one for a code, in the context of one action. */
export type ErrorTexts = Partial<Record<ErrorCode, MessageKey>>;

export function errorCodeOf(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

/**
 * The text for a failed request. The server answers the protection rules (the last owner, the
 * last server admin, granting more than one holds) with `conflict` or `forbidden`; the caller
 * knows which action failed and passes the readable text for it.
 */
export function errorText(t: Translate, error: unknown, texts: ErrorTexts = {}): string {
  const code = errorCodeOf(error);
  return t(texts[code] ?? `errors.${code}`);
}

/** Changing or removing a member: the last owner stays, and nobody grants more than they hold. */
export const MEMBER_ERRORS: ErrorTexts = {
  conflict: "admin.members.lastOwner",
  forbidden: "admin.members.cannotGrant",
};

/** Demoting or disabling a server admin: the last one stays. */
export const SERVER_ADMIN_ERRORS: ErrorTexts = {
  conflict: "admin.users.lastServerAdmin",
};

/** Saving a role or granting access with permissions one does not hold. */
export const GRANT_ERRORS: ErrorTexts = {
  forbidden: "admin.roles.cannotGrant",
};
