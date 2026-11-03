// How a time range reads in the picker's button and wherever a range is named (settings, Explore):
// apart from the picker, so naming a range does not load the picker's popover.
import type { Translate } from "../../i18n/i18n";
import { getTimeSettings, zoneOption } from "../../lib/timeSettings";
import { isRelative, type Preset, presetOf, resolveTime, type TextRange } from "./timeRange";

export function presetLabel(t: Translate, preset: Preset): string {
  return t(preset.label);
}

/** One end as the user reads it: relative text as typed, absolute times in local format. */
function endLabel(text: string, language: string, zone: string | null): string {
  if (isRelative(text)) {
    return text;
  }
  const time = resolveTime(text, Date.now(), false, { ...getTimeSettings(), timeZone: zone });
  return time === null
    ? text
    : new Intl.DateTimeFormat(language, {
        dateStyle: "short",
        timeStyle: "short",
        ...zoneOption(zone),
      }).format(time);
}

export function rangeLabel(
  t: Translate,
  language: string,
  range: TextRange,
  zone: string | null,
): string {
  const preset = presetOf(range);
  if (preset !== undefined) {
    return presetLabel(t, preset);
  }
  return `${endLabel(range.from, language, zone)} – ${endLabel(range.to, language, zone)}`;
}

/** The zone's offset from UTC now, as the browser writes it: "GMT+2". */
export function zoneOffset(language: string, zone: string | null): string {
  return (
    new Intl.DateTimeFormat(language, { timeZoneName: "shortOffset", ...zoneOption(zone) })
      .formatToParts(Date.now())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}
