import {
  characterCount,
  type FieldMessage,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  trimWhitespace,
} from "../../auth/validation";
import type { MessageKey } from "../../i18n/i18n";

// The server's rules for names and new passwords (the same as at setup, auth/validation.ts),
// checked here first so the user learns about a problem without a round trip.

const CONTROL = /\p{Cc}/u;

/** A team, role, organization or person name: required, at most 100 characters, one line. */
export function nameMessage(
  value: string,
  required: MessageKey = "admin.common.nameRequired",
): FieldMessage | undefined {
  const trimmed = trimWhitespace(value);
  if (trimmed === "") {
    return { key: required };
  }
  if (CONTROL.test(trimmed)) {
    return { key: "validation.controlCharacters" };
  }
  if (characterCount(trimmed) > MAX_NAME_LENGTH) {
    return { key: "validation.tooLong", params: { count: MAX_NAME_LENGTH } };
  }
  return undefined;
}

export function newPasswordMessage(password: string): FieldMessage | undefined {
  const length = characterCount(password);
  if (length === 0) {
    return { key: "validation.passwordRequired" };
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return { key: "validation.passwordTooShort", params: { count: MIN_PASSWORD_LENGTH } };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { key: "validation.passwordTooLong", params: { count: MAX_PASSWORD_LENGTH } };
  }
  return undefined;
}
