import { isApiError, isRecord, SERVER_ERROR_CODES } from "../../../api/client";
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
  if (isApiError(error) && error.code === "internal") {
    return withRequestId(t, t("errors.internal"), requestIdOf(error.body));
  }
  return t(isApiError(error) ? `errors.${error.code}` : "errors.internal");
}

/** The id the server logged an internal error under (`error.requestId` of the answer). */
export function requestIdOf(body: unknown): string | undefined {
  const error = isRecord(body) ? body.error : undefined;
  const id = isRecord(error) ? error.requestId : isRecord(body) ? body.requestId : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** The text with the request id after it, so the server log line can be found. */
function withRequestId(t: Translate, text: string, id: string | undefined): string {
  return id === undefined ? text : `${text} ${t("errors.requestId", { id })}`;
}

/** The text for an error code alone, such as a failed health check without a reason. */
export function errorCodeMessage(t: Translate, code: string): string {
  const known = SERVER_ERROR_CODES.find((candidate) => candidate === code);
  return t(known === undefined ? "errors.internal" : `errors.${known}`);
}

/** The text for an error body inside a response, such as the failed query of one panel. */
export function errorBodyMessage(
  t: Translate,
  body: {
    code: string;
    message: string;
    reason?: string;
    params?: Record<string, string>;
    requestId?: string;
  },
): string {
  const reason = bodyReason(body);
  const text = reason === undefined ? undefined : reasonText(t, reason);
  if (text !== undefined) {
    return text;
  }
  const code = errorCodeMessage(t, body.code);
  return body.code === "internal" ? withRequestId(t, code, body.requestId) : code;
}
