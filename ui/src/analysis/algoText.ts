import type { StepSummary } from "../api/generated/shapes";
import { hasMessage, type MessageKey, type Translate } from "../i18n/i18n";

/**
 * The words of the graph algorithm steps: the sentence a step sums its result up in, and where
 * it computed and why (board Graph082, frames 3, 4 and 16).
 */

/** A number as the sentence shows it: grouped digits, at most three decimals. */
export function summaryNumber(value: number, language: string): string {
  const digits = Number.isInteger(value) ? 0 : Math.abs(value) >= 100 ? 1 : 3;
  return new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
}

/**
 * The sentence of a step's summary in the UI's language ("3 Communities, Modularität 0,30. Die
 * größte hat 5 Knoten."), numbers formatted for the language; null for a key this UI does not
 * know (a newer server), so nothing untranslated shows.
 */
export function summarySentence(
  t: Translate,
  language: string,
  summary: StepSummary | undefined,
): string | null {
  if (summary === undefined) return null;
  const key = summary.key;
  if (!key.startsWith("analysis.summary.") || !hasMessage(key)) return null;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(summary.values)) {
    if (typeof value === "number") params[name] = summaryNumber(value, language);
    else if (typeof value === "string") params[name] = value;
    else if (typeof value === "boolean") params[name] = String(value);
  }
  // A cut list says so with its own sentence (cycles and paths).
  if (key === "analysis.summary.cycles" && summary.values.cut === true) {
    return t("analysis.summary.cyclesCut", params);
  }
  if (key === "analysis.summary.paths" && typeof summary.values.total === "number") {
    return t("analysis.summary.pathsCut", params);
  }
  if (key === "analysis.summary.paths" && summary.values.mode === "weighted") {
    return t("analysis.summary.pathsWeighted", params);
  }
  if (key === "analysis.summary.centrality" && summary.values.allSame === true) {
    return t("analysis.summary.centralitySame", params);
  }
  return t(key as MessageKey, params);
}

/** Why a step ran on the server, in plain words; null when the server named no reason. */
export function placeReason(t: Translate, reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const key = `analysis.place.${reason}`;
  return hasMessage(key) ? t(key) : null;
}
