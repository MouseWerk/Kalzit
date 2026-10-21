import { isApiError, SERVER_ERROR_CODES } from "../../../api/client";
import type { Translate } from "../../../i18n/i18n";

/** The user-facing text for any failure: the translation of its error code, never the raw text. */
export function errorMessage(t: Translate, error: unknown): string {
  return t(isApiError(error) ? `errors.${error.code}` : "errors.internal");
}

/** The text for an error code from a response body, such as a failed query of one panel. */
export function errorCodeMessage(t: Translate, code: string): string {
  const known = SERVER_ERROR_CODES.find((candidate) => candidate === code);
  return t(known === undefined ? "errors.internal" : `errors.${known}`);
}
