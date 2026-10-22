import { isApiError, isRecord } from "../../api/client";
import type { Notice } from "../../api/generated/shapes";
import { catalogs, type MessageKey, type Translate } from "../../i18n/i18n";

/**
 * A reason as the server sends it: on errors (`error.reason`, `error.params`), health answers
 * (`reason`, `params`) and notices (`code`, `params`), with its English text as the fallback
 * (docs/api/datasources.md, "Reasons").
 */
export interface Reason {
  reason: string;
  params?: Record<string, string> | undefined;
  /** The server's English text with the same content. */
  fallback?: string | undefined;
}

const PREFIX = "datasources.reason.";

/** The catalog key of a reason this UI knows. */
export function reasonKey(reason: string): MessageKey | undefined {
  const key = `${PREFIX}${reason}`;
  return Object.hasOwn(catalogs.en, key) ? (key as MessageKey) : undefined;
}

/** The params as the texts use them: one name per value, whichever the server sent. */
function fill(reason: string, params: Record<string, string>): Record<string, string> {
  // `target.metadata_address` names an address or a host; the text says {host} for both.
  if (reason === "target.metadata_address" && params.host === undefined && params.address) {
    return { ...params, host: params.address };
  }
  return params;
}

/** Params of analysis reasons that name a type (`number`, `int64`, ...), shown in the UI's words. */
const TYPE_PARAMS = ["type", "left", "right", "expected", "found", "first", "second"];
const TYPE_PHRASES: Record<string, string> = {
  "a number, text or time": "orderable",
  "a value": "any",
};

function typeWords(t: Translate, reason: string, params: Record<string, string>) {
  if (!reason.startsWith("expression.") && !reason.startsWith("steps.")) {
    return params;
  }
  const out = { ...params };
  for (const name of TYPE_PARAMS) {
    const value = out[name];
    if (value === undefined) continue;
    const key = `analysis.valueType.${TYPE_PHRASES[value] ?? value}`;
    if (Object.hasOwn(catalogs.en, key)) {
      out[name] = t(key as MessageKey);
    }
  }
  return out;
}

/**
 * The text of a reason: the translation when this UI knows it, else the server's English text,
 * else undefined (the caller falls back to the error code).
 */
export function reasonText(t: Translate, { reason, params, fallback }: Reason): string | undefined {
  // `settings.out_of_range` sends `max` only when the setting has an upper bound.
  if (reason === "settings.out_of_range" && params?.max === undefined && params?.min) {
    return t("datasources.form.atLeast", { min: params.min });
  }
  const key = reasonKey(reason);
  if (key !== undefined) {
    return t(key, typeWords(t, reason, fill(reason, params ?? {})));
  }
  return fallback === undefined || fallback === "" ? undefined : fallback;
}

export function stringParams(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, param]) =>
      typeof param === "string" ? [[name, param]] : [],
    ),
  );
}

/** The reason of an error body (`{ code, message, reason?, params? }`), if it has one. */
export function bodyReason(body: unknown): Reason | undefined {
  if (!isRecord(body) || typeof body.reason !== "string" || body.reason === "") {
    return undefined;
  }
  return {
    reason: body.reason,
    params: stringParams(body.params),
    fallback: typeof body.message === "string" ? body.message : undefined,
  };
}

/** The reason of a failed request, read from the error body the client kept. */
export function errorReason(error: unknown): Reason | undefined {
  if (!isApiError(error) || !isRecord(error.body)) {
    return undefined;
  }
  return bodyReason(error.body.error);
}

/** A result notice (`frame.row_limit`, `prometheus.warning`, ...) in the UI's language. */
export function noticeText(t: Translate, notice: Notice): string {
  return reasonText(t, { reason: notice.code, params: notice.params, fallback: notice.text }) ?? "";
}
