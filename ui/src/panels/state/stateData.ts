import type { Frame } from "../../api/generated/shapes";
import {
  displayNameOf,
  displayText,
  displayValue,
  type FieldConfig,
  fieldOptionsFor,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { timeField, toNumber } from "../frame";

/** Time points a state panel works with at most; longer results are thinned to this. */
export const MAX_STATE_POINTS = 500;
/** The legend names this many values at most; a number field would otherwise list each one. */
export const MAX_LEGEND_VALUES = 24;

/** One value of a state row: its text and the class that colors it. */
export interface StateValue {
  text: string;
  colorClass: string;
}

export interface StateRow {
  name: string;
  /** One entry per time point; null where the row has no value. */
  values: (StateValue | null)[];
}

export interface StateData {
  times: number[];
  rows: StateRow[];
  /** Every distinct value with its color, in order of appearance, for the legend. */
  legend: StateValue[];
}

/** Words that name a state, in English and German, by the tone that means it. */
const STATE_WORDS: Record<"ok" | "warn" | "critical" | "neutral", readonly string[]> = {
  ok: [
    "ok",
    "up",
    "healthy",
    "success",
    "succeeded",
    "online",
    "running",
    "pass",
    "passed",
    "ready",
    "active",
    "green",
    "gesund",
    "erfolgreich",
    "läuft",
    "bereit",
    "aktiv",
  ],
  warn: [
    "warn",
    "warning",
    "degraded",
    "pending",
    "slow",
    "unstable",
    "yellow",
    "warnung",
    "eingeschränkt",
    "ausstehend",
    "langsam",
  ],
  critical: [
    "down",
    "error",
    "failed",
    "fail",
    "failure",
    "critical",
    "offline",
    "crashed",
    "red",
    "fehler",
    "fehlgeschlagen",
    "ausgefallen",
    "kritisch",
  ],
  neutral: ["unknown", "none", "n/a", "skipped", "stopped", "idle", "paused", "unbekannt"],
};

/**
 * The tone a state's own word stands for ("ok" good, "down" danger, "degraded" warning,
 * "unknown" neutral), so a status column reads at a glance without value mappings. Mappings,
 * thresholds and a field color the author set win.
 */
export function stateTone(text: string): "ok" | "warn" | "critical" | "neutral" | undefined {
  const word = text.trim().toLowerCase();
  for (const [tone, words] of Object.entries(STATE_WORDS)) {
    if (words.includes(word)) {
      return tone as keyof typeof STATE_WORDS;
    }
  }
  return undefined;
}

/**
 * Every field except time becomes a row of states over the frame's time points. A value's color
 * comes from its mapping or the thresholds, else from a state word it is (stateTone); other
 * values take palette colors in the order they first appear, the same color for the same text
 * in every row.
 */
export function stateData(
  frames: readonly Frame[],
  config: FieldConfig,
  language: string,
): StateData | null {
  const frame = frames.find(
    (f) => timeField(f) !== undefined && f.fields.some((field) => field.type !== "time"),
  );
  const time = frame === undefined ? undefined : timeField(frame);
  if (frame === undefined || time === undefined) {
    return null;
  }
  const sorted = time.values
    .map((raw, index) => ({ time: toNumber(raw), index }))
    .filter((p): p is { time: number; index: number } => p.time !== null)
    .sort((a, b) => a.time - b.time);
  // Far more points than pixels: each stretch keeps its last value, so a long result draws as
  // fast as a short one. A state shorter than one stretch can drop out; zooming in shows it.
  const order =
    sorted.length <= MAX_STATE_POINTS
      ? sorted
      : Array.from(
          { length: MAX_STATE_POINTS },
          (_, i) =>
            sorted[
              Math.min(
                sorted.length - 1,
                Math.floor(((i + 1) * sorted.length) / MAX_STATE_POINTS) - 1,
              )
            ] as { time: number; index: number },
        );
  const palette = new Map<string, number>();
  const legend = new Map<string, StateValue>();
  const rows = frame.fields
    .filter((field) => field.type !== "time")
    .map((field) => {
      const options = fieldOptionsFor(field, config);
      const values = order.map(({ index }) => {
        const raw = field.values[index];
        if (raw === null || raw === undefined) {
          return null;
        }
        const display = displayValue(raw, field.type, options, language);
        const text = displayText(display);
        let colorClass: string;
        const known = options.color === undefined ? stateTone(text) : undefined;
        if (display.tone !== undefined) {
          colorClass = toneClass(display.tone);
        } else if (known !== undefined) {
          colorClass = toneClass(known);
        } else {
          if (!palette.has(text)) palette.set(text, palette.size);
          colorClass = toneClass(options.color, palette.get(text));
        }
        const value = { text, colorClass };
        if (legend.size < MAX_LEGEND_VALUES && !legend.has(`${text}|${colorClass}`)) {
          legend.set(`${text}|${colorClass}`, value);
        }
        return value;
      });
      return { name: displayNameOf(field, options), values };
    });
  return { times: order.map((p) => p.time), rows, legend: [...legend.values()] };
}

export interface Segment {
  value: StateValue;
  from: number;
  to: number;
}

/**
 * A row as runs of equal values: a run lasts until the next different value, the last one until
 * the end of the range. A missing value ends a run and starts none.
 */
export function segments(row: StateRow, times: readonly number[], end: number): Segment[] {
  const result: Segment[] = [];
  let current: Segment | null = null;
  for (let i = 0; i < row.values.length; i++) {
    const value = row.values[i] ?? null;
    const at = times[i] as number;
    const same =
      current !== null &&
      value !== null &&
      value.text === current.value.text &&
      value.colorClass === current.value.colorClass;
    if (current !== null && !same) {
      current.to = at;
      result.push(current);
      current = null;
    }
    if (value !== null && current === null) {
      current = { value, from: at, to: at };
    }
  }
  if (current !== null) {
    current.to = Math.max(end, current.from);
    result.push(current);
  }
  return result;
}

/**
 * Runs shorter than `minimum` (a pixel's worth of time) are folded into the run before them, so a
 * row never draws more rectangles than it has pixels. A narrow first run is kept; the next one
 * that is wide enough stands on its own again.
 */
export function mergeNarrow(runs: readonly Segment[], minimum: number): Segment[] {
  const merged: Segment[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous !== undefined && run.to - run.from < minimum && run.from <= previous.to) {
      previous.to = Math.max(previous.to, run.to);
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

/**
 * Status history columns: every time point, or with more than `max` points the last value of
 * each of `max` equal stretches, so cells never get thinner than a few pixels.
 */
export function columns(data: StateData, max: number): number[] {
  const count = data.times.length;
  if (count <= max) {
    return Array.from({ length: count }, (_, i) => i);
  }
  return Array.from({ length: max }, (_, i) =>
    Math.min(count - 1, Math.floor(((i + 1) * count) / max) - 1),
  );
}
