import type { KeyboardEvent } from "react";
import { isApiError } from "../api/client";
import type { MessageKey, MessageParams } from "../i18n/i18n";

// The same limits the server enforces (server validation of setup and accounts); the UI checks
// them first so the user learns about a problem without a round trip.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_NAME_LENGTH = 100;

/** A message for one field, with the values its placeholders need. */
export interface FieldMessage {
  key: MessageKey;
  params?: MessageParams;
}

export type FieldErrors<Field extends string> = Partial<Record<Field, FieldMessage>>;

export type LoginField = "email" | "password";
export type SetupField = "token" | "orgName" | "name" | "email" | "password";

export interface LoginValues {
  email: string;
  password: string;
}

export interface SetupValues {
  token: string;
  orgName: string;
  name: string;
  email: string;
  password: string;
}

/**
 * Counts characters as code points, not UTF-16 units, so a character outside the BMP counts
 * once, as it does on the server.
 */
export function characterCount(value: string): number {
  return Array.from(value).length;
}

const CONTROL = /\p{Cc}/u;

function message(key: MessageKey, params?: MessageParams): FieldMessage {
  return params === undefined ? { key } : { key, params };
}

// Unicode White_Space, the set Rust's char::is_whitespace and str::trim use on the server. JS's
// \s and String.prototype.trim differ: they include U+FEFF and leave out U+0085.
const WHITE_SPACE = /\p{White_Space}/u;
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Trims exactly what the server trims. */
export function trimWhitespace(value: string): string {
  return value.replace(EDGE_WHITE_SPACE, "");
}

// The server's rule for a new account: one "@", no white space or control characters, and a
// domain with a dot that neither starts nor ends with one.
function newEmailError(email: string): FieldMessage | undefined {
  const trimmed = trimWhitespace(email);
  if (trimmed === "") {
    return message("validation.emailRequired");
  }
  const at = trimmed.indexOf("@");
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const valid =
    at > 0 &&
    !domain.includes("@") &&
    !WHITE_SPACE.test(trimmed) &&
    !CONTROL.test(trimmed) &&
    local !== "" &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".");
  return valid ? undefined : message("validation.emailInvalid");
}

/** Names and organization names: 1 to 100 characters after trimming, no control characters. */
function nameError(value: string, required: MessageKey): FieldMessage | undefined {
  const trimmed = trimWhitespace(value);
  if (trimmed === "") {
    return message(required);
  }
  if (CONTROL.test(trimmed)) {
    return message("validation.controlCharacters");
  }
  if (characterCount(trimmed) > MAX_NAME_LENGTH) {
    return message("validation.tooLong", { count: MAX_NAME_LENGTH });
  }
  return undefined;
}

function newPasswordError(password: string): FieldMessage | undefined {
  const length = characterCount(password);
  if (length === 0) {
    return message("validation.passwordRequired");
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return message("validation.passwordTooShort", { count: MIN_PASSWORD_LENGTH });
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return message("validation.passwordTooLong", { count: MAX_PASSWORD_LENGTH });
  }
  return undefined;
}

function withoutEmpty<Field extends string>(
  errors: Record<Field, FieldMessage | undefined>,
): FieldErrors<Field> {
  const result: FieldErrors<Field> = {};
  for (const field of Object.keys(errors) as Field[]) {
    const error = errors[field];
    if (error !== undefined) {
      result[field] = error;
    }
  }
  return result;
}

// Sign-in only catches an obvious slip: the server checks no shape at login, and a stricter UI
// could lock out someone whose address an older rule accepted.
function loginEmailError(email: string, username: boolean): FieldMessage | undefined {
  const trimmed = trimWhitespace(email);
  if (trimmed === "") {
    return message(username ? "validation.loginRequired" : "validation.emailRequired");
  }
  return username || trimmed.includes("@") ? undefined : message("validation.emailInvalid");
}

/**
 * The password sign-in. `username`: an LDAP directory is set up, so the first field takes an email
 * or a directory user name (docs/api/sso.md, "LDAP and Active Directory").
 */
export function validateLogin(values: LoginValues, username = false): FieldErrors<LoginField> {
  return withoutEmpty<LoginField>({
    email: loginEmailError(values.email, username),
    // No length rule here: an existing password is whatever the server accepted back then.
    password: values.password === "" ? message("validation.passwordRequired") : undefined,
  });
}

export function validateSetup(values: SetupValues): FieldErrors<SetupField> {
  return withoutEmpty<SetupField>({
    token: trimWhitespace(values.token) === "" ? message("validation.tokenRequired") : undefined,
    orgName: nameError(values.orgName, "validation.orgNameRequired"),
    name: nameError(values.name, "validation.nameRequired"),
    email: newEmailError(values.email),
    password: newPasswordError(values.password),
  });
}

/** A new account from an invitation: name and password, as setup checks them. */
export function validateNewAccount(values: {
  name: string;
  password: string;
}): FieldErrors<"name" | "password"> {
  return withoutEmpty<"name" | "password">({
    name: nameError(values.name, "validation.nameRequired"),
    password: newPasswordError(values.password),
  });
}

/** A new password from a password link. */
export function validateNewPassword(password: string): FieldErrors<"password"> {
  return withoutEmpty<"password">({ password: newPasswordError(password) });
}

/** An address to send a password link to: the same rough shape sign-in checks. */
export function validateResetEmail(email: string): FieldErrors<"email"> {
  return withoutEmpty<"email">({ email: loginEmailError(email, false) });
}

export type PasswordStrengthLevel = "empty" | "short" | "fair" | "strong";

const CHARACTER_KINDS = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u];

/**
 * A rough guide while a new password is typed, not a rule: the server only checks the length.
 * Length alone reaches "fair" ("good length"); the top level also needs a mix of at least three
 * kinds of characters (lower and upper case, digits, others), so length alone is never "strong".
 */
export function passwordStrength(password: string): {
  level: PasswordStrengthLevel;
  length: number;
} {
  const length = characterCount(password);
  if (length === 0) {
    return { level: "empty", length };
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return { level: "short", length };
  }
  const kinds = CHARACTER_KINDS.filter((kind) => kind.test(password)).length;
  const strong = length >= 16 && kinds >= 3;
  return { level: strong ? "strong" : "fair", length };
}

/** The form field a server `validation` error names, if it is one of this form's fields. */
export function fieldFromServer<Field extends string>(
  order: readonly Field[],
  error: unknown,
): Field | undefined {
  if (!isApiError(error, "validation")) {
    return undefined;
  }
  return order.find((field) => field === error.field);
}

/** The first field with an error, in the order the form shows them. */
export function firstInvalid<Field extends string>(
  order: readonly Field[],
  errors: FieldErrors<Field>,
): Field | undefined {
  return order.find((field) => errors[field] !== undefined);
}

/**
 * Stops Enter from submitting while an input method editor is composing (Japanese, Chinese,
 * Korean input confirm a candidate with Enter). Safari reports the confirming keydown with
 * isComposing already false, but keyCode 229, so both are checked.
 */
export function preventComposingSubmit(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
    event.preventDefault();
  }
}
