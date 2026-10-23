import { isApiError } from "../api/client";
import type { Translate } from "../i18n/i18n";

/** The translated text of a failed request. */
export function apiErrorText(t: Translate, error: unknown): string {
  return t(isApiError(error) ? `errors.${error.code}` : "errors.internal");
}
