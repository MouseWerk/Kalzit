import type { Translate } from "../i18n/i18n";
import { zoneOption } from "../lib/timeSettings";
import type { TimeFormat } from "./prefs";

/** Times of log lines as the bar's time menu sets them (board Logs.dc.html, frame 3). */

const formats = new Map<string, Intl.DateTimeFormat>();

function format(language: string, zone: string | null, kind: TimeFormat): Intl.DateTimeFormat {
  const key = `${language}|${zone ?? ""}|${kind}`;
  let found = formats.get(key);
  if (found === undefined) {
    const time: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    };
    const day: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit" };
    found = new Intl.DateTimeFormat(language, {
      ...(kind === "time" ? {} : day),
      ...time,
      ...(kind === "ms" ? { fractionalSecondDigits: 3 } : {}),
      ...zoneOption(zone),
    });
    formats.set(key, found);
  }
  return found;
}

const relative = new Map<string, Intl.RelativeTimeFormat>();

function relativeText(language: string, ms: number, now: number): string {
  let found = relative.get(language);
  if (found === undefined) {
    found = new Intl.RelativeTimeFormat(language, { numeric: "always", style: "short" });
    relative.set(language, found);
  }
  const seconds = Math.round((ms - now) / 1_000);
  const abs = Math.abs(seconds);
  if (abs < 60) return found.format(seconds, "second");
  if (abs < 3_600) return found.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return found.format(Math.round(seconds / 3_600), "hour");
  return found.format(Math.round(seconds / 86_400), "day");
}

/** A line's time as the list shows it; empty where the time is hidden. */
export function lineTime(
  ms: number | null,
  kind: TimeFormat,
  language: string,
  zone: string | null,
  t: Translate,
  now = Date.now(),
): string {
  if (kind === "off") return "";
  if (ms === null) return t("logs.noTime");
  if (kind === "relative") return relativeText(language, ms, now);
  return format(language, zone, kind).format(ms);
}

const fullFormats = new Map<string, Intl.DateTimeFormat>();

/** The full time of a line for its details: date, time with ms, and the zone it is read in. */
export function fullTime(ms: number, language: string, zone: string | null): string {
  const key = `${language}|${zone ?? ""}`;
  let found = fullFormats.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(language, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
      timeZoneName: "short",
      ...zoneOption(zone),
    });
    fullFormats.set(key, found);
  }
  return found.format(ms);
}

/** A bar's width in words ("1 min", "30 s"), for the volume's caption. */
export function stepText(stepMs: number, language: string): string {
  const units: [number, Intl.NumberFormatOptions["unit"]][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, unit] of units) {
    if (stepMs >= size && stepMs % size === 0) {
      return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short" }).format(
        stepMs / size,
      );
    }
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: "millisecond",
    unitDisplay: "short",
  }).format(stepMs);
}
