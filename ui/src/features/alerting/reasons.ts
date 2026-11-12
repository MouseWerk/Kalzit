import { hasMessage, type Translate } from "../../i18n/i18n";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason, reasonText } from "../datasources/reasons";
import type { AlertError } from "./api";

/**
 * Texts of alerting's own reasons (docs/api/alerting.md, "Reasons") and of evaluation errors
 * (`{ code, params }` of an instance, a rule or a history entry). Always from the catalogs: an
 * unknown code reads as a general failure, never as the server's own text.
 */

/** The text of a failed request: an `alerts.*` reason from this area, else the shared texts. */
export function alertingErrorText(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  if (reason !== undefined) {
    const key = `alerting.reason.${reason.reason}`;
    if (hasMessage(key)) {
      return t(key, reason.params ?? {});
    }
  }
  return errorMessage(t, error);
}

/** The field an `alerts.*` reason is about, to show it there. */
export function reasonField(error: unknown): string | undefined {
  const reason = errorReason(error)?.reason;
  switch (reason) {
    case "alerts.query_invalid":
      return "query";
    case "alerts.reduce_path_invalid":
      return "documentsPath";
    case "alerts.condition_invalid":
      return "value";
    case "alerts.interval_invalid":
      return "intervalSecs";
    case "alerts.for_invalid":
      return "forSecs";
    case "alerts.labels_invalid":
      return "labels";
    case "alerts.runbook_url_invalid":
      return "runbookUrl";
    case "alerts.too_many_contact_points":
      return "contactPointIds";
    case "alerts.datasource_not_opted_in":
    case "alerts.datasource_forbidden":
      return "datasourceId";
    default:
      return undefined;
  }
}

/** Codes whose text needs nothing from the data. */
const PLAIN_ERRORS = new Set([
  "query_failed",
  "timeout",
  "source_not_enabled",
  "invalid_rule",
  "no_paths",
  "truncated",
  // Its parameters are the server's limits, not the data's.
  "label_too_long",
]);

/**
 * Why an evaluation failed, in the UI's language. With `hidden` the caller may not read the rule's
 * source and the server sent the code without its parameters: codes whose text needs them read
 * as a neutral "details hidden".
 */
export function evalErrorText(t: Translate, error: AlertError, hidden = false): string {
  const code = error.code.startsWith("alerting.")
    ? error.code.slice("alerting.".length)
    : error.code;
  if (hidden && !PLAIN_ERRORS.has(code)) {
    return t("alerting.dataHidden.error");
  }
  const key = `alerting.evalError.${code}`;
  const params = { ...(error.params ?? {}) };
  if (params.found !== undefined) {
    const found = `alerting.found.${params.found}`;
    if (hasMessage(found)) params.found = t(found);
  }
  if (code === "truncated") {
    if (params.reason === undefined) {
      return t("alerting.evalError.truncated");
    }
    const why = `alerting.truncatedBy.${params.reason}`;
    return t("alerting.evalError.truncatedBy", {
      reason: t(hasMessage(why) ? why : "alerting.truncatedBy.other"),
    });
  }
  return hasMessage(key) ? t(key, params) : t("alerting.evalError.unknown");
}

/**
 * How a delivery went: a receiver's HTTP status as "HTTP 503", a known reason in words, a mail
 * reason through the shared texts, anything else as a failed delivery. Never the receiver's text.
 */
export function deliveryResultText(t: Translate, result: string): string {
  if (/^\d{3}$/.test(result)) {
    return t("alerting.result.status", { status: result });
  }
  const key = `alerting.result.${result}`;
  if (hasMessage(key)) {
    return t(key);
  }
  return reasonText(t, { reason: result }) ?? t("alerting.result.failed");
}
