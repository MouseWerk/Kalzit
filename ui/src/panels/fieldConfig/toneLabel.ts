import type { MessageKey, MessageParams } from "../../i18n/i18n";
import type { Tone } from "./fieldConfig";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** A tone's name in the UI language: the state tones by meaning, the palette by number. */
export function toneLabel(t: Translate, tone: Tone): string {
  if (tone.startsWith("chart-")) {
    return t("panels.tone.chart", { number: tone.slice("chart-".length) });
  }
  return t(`panels.tone.${tone as "ok" | "warn" | "critical" | "neutral"}`);
}
