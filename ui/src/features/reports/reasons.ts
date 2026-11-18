import { isApiError } from "../../api/client";
import { hasMessage, type Translate } from "../../i18n/i18n";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import type { DraftField } from "./model";

/**
 * Texts of the reports' own reasons (docs/api/reports.md, "Reasons"): refused requests, why a
 * report is suspended and why a run failed share one list. A reason this UI has no text for
 * reads as the server's English text, as the API documents.
 */

const PREFIX = "reports.";

function reasonKey(code: string) {
  const key = `reports.reason.${code.startsWith(PREFIX) ? code.slice(PREFIX.length) : code}`;
  return hasMessage(key) ? key : undefined;
}

/** The text of a failed request: a `reports.*` reason from this area, else the shared texts. */
export function reportErrorText(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  const key = reason === undefined ? undefined : reasonKey(reason.reason);
  if (reason !== undefined && key !== undefined) {
    return t(key, reason.params ?? {});
  }
  // Previews and "send now" are limited; it passes by itself.
  if (isApiError(error, "rate_limited")) {
    return t("reports.reason.rate_limited");
  }
  return errorMessage(t, error);
}

/** Why a run failed or a report is suspended: `{ code, message }` as the server stored it. */
export function codeText(t: Translate, problem: { code: string; message: string }): string {
  const key = reasonKey(problem.code);
  if (key !== undefined) return t(key);
  return problem.message === "" ? t("reports.reason.internal") : problem.message;
}

const FIELDS: readonly DraftField[] = [
  "name",
  "dashboardId",
  "panelIds",
  "timeRange",
  "schedule",
  "timeZone",
  "formats",
  "recipients",
];

/** The field of the editor a refused save is about, as the server names it. */
export function errorField(error: unknown): DraftField | undefined {
  if (!isApiError(error)) return undefined;
  // The day of a monthly schedule has a field of its own in the form.
  if (errorReason(error)?.reason === "reports.day_invalid") return "day";
  return FIELDS.find((field) => field === error.field);
}

/** The recipient a refusal names by its position in the body. */
export function errorRecipient(error: unknown): number | undefined {
  const index = Number(errorReason(error)?.params?.index ?? Number.NaN);
  return Number.isInteger(index) ? index : undefined;
}
