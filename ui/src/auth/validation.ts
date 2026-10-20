import type { KeyboardEvent } from "react";
import type { MessageKey } from "../i18n/i18n";

/** Same minimum the server enforces for new passwords. */
export const MIN_PASSWORD_LENGTH = 12;

export type FieldErrors<Field extends string> = Partial<Record<Field, MessageKey>>;

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
 * Counts characters as the user sees them in most cases (code points, not UTF-16 units), so an
 * emoji or a character outside the BMP counts once, as it does on the server.
 */
export function characterCount(value: string): number {
  return Array.from(value).length;
}

// Deliberately loose: one "@" with something on both sides. The server has the final word; the
// UI only catches obvious typos without rejecting unusual but valid addresses.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

function emailError(email: string): MessageKey | undefined {
  const trimmed = email.trim();
  if (trimmed === "") {
    return "validation.emailRequired";
  }
  return EMAIL_SHAPE.test(trimmed) ? undefined : "validation.emailInvalid";
}

function withoutEmpty<Field extends string>(
  errors: Record<Field, MessageKey | undefined>,
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

export function validateLogin(values: LoginValues): FieldErrors<LoginField> {
  return withoutEmpty<LoginField>({
    email: emailError(values.email),
    // No length rule here: an existing password is whatever the server accepted back then.
    password: values.password === "" ? "validation.passwordRequired" : undefined,
  });
}

export function validateSetup(values: SetupValues): FieldErrors<SetupField> {
  let password: MessageKey | undefined;
  if (values.password === "") {
    password = "validation.passwordRequired";
  } else if (characterCount(values.password) < MIN_PASSWORD_LENGTH) {
    password = "validation.passwordTooShort";
  }
  return withoutEmpty<SetupField>({
    token: values.token.trim() === "" ? "validation.tokenRequired" : undefined,
    orgName: values.orgName.trim() === "" ? "validation.orgNameRequired" : undefined,
    name: values.name.trim() === "" ? "validation.nameRequired" : undefined,
    email: emailError(values.email),
    password,
  });
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
