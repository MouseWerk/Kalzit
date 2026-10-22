import { isApiError, SERVER_ERROR_CODES } from "../../../api/client";
import type { Translate } from "../../../i18n/i18n";
import { bodyReason, errorReason, reasonText } from "../../datasources/reasons";

/**
 * The user-facing text for any failure: the translation of its reason when the server sent one
 * (the server's English text when this UI does not know it), else that of its error code.
 */
export function errorMessage(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  const text = reason === undefined ? undefined : reasonText(t, reason);
  if (text !== undefined) {
    return text;
  }
  return t(isApiError(error) ? `errors.${error.code}` : "errors.internal");
}

/** The text for an error code alone, such as a failed health check without a reason. */
export function errorCodeMessage(t: Translate, code: string): string {
  const known = SERVER_ERROR_CODES.find((candidate) => candidate === code);
  return t(known === undefined ? "errors.internal" : `errors.${known}`);
}

/** The text for an error body inside a response, such as the failed query of one panel. */
export function errorBodyMessage(
  t: Translate,
  body: { code: string; message: string; reason?: string; params?: Record<string, string> },
): string {
  const reason = bodyReason(body);
  return (
    (reason === undefined ? undefined : reasonText(t, reason)) ?? errorCodeMessage(t, body.code)
  );
}
