import type { Frame } from "../../api/generated/shapes";
import {
  displayNameOf,
  displayText,
  displayValue,
  type FieldConfig,
  fieldOptionsFor,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { distinctSeriesNames, frameName, timeField, toNumber } from "../frame";

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

/**
 * The words that name a state unambiguously, in English and German, by the tone that means them.
 * Only whole values match ("down", not "Down Under" or "up-to-date"); words that are often plain
 * values (red, active, running, idle ...) are left out on purpose. docs/ARCHITECTURE.md lists them.
 */
export const STATE_WORDS: Record<"ok" | "warn" | "critical" | "neutral", readonly string[]> = {
  ok: ["ok", "up", "healthy", "success", "passed", "gesund", "erfolgreich", "bestanden"],
  warn: ["warning", "degraded", "pending", "warnung", "eingeschränkt", "ausstehend"],
  critical: [
    "down",
    "error",
    "failed",
    "failure",
    "critical",
    "offline",
    "fehler",
    "fehlgeschlagen",
    "ausgefallen",
    "kritisch",
  ],
  neutral: ["unknown", "unbekannt"],
};

/**
 * The tone a state's own word stands for ("ok" good, "down" danger, "degraded" warning,
 * "unknown" neutral), so a status column reads at a glance without value mappings. The whole
 * value must be the word, in any case and with surrounding spaces.
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

/** A frame's points in time order: time and the row index that holds its values. */
function timeOrder(frame: Frame): { time: number; index: number }[] {
  const time = timeField(frame);
  return (time?.values ?? [])
    .map((raw, index) => ({ time: toNumber(raw), index }))
    .filter((p): p is { time: number; index: number } => p.time !== null)
    .sort((a, b) => a.time - b.time);
}

/**
 * Every field except time of every frame with a time field becomes a row of states, so a panel
 * with one query per service shows one row per service. The rows share the time points of all
 * frames; where a frame has no point of its own, its row holds its last state, as a state lasts
 * until it changes (and has none before its first point); with `hold` off it has no value there.
 * A value's color comes, in this order, from its mapping, the thresholds, the field's color, the
 * state word it is (stateTone, unless `stateWords` is off), and else the palette in the order
 * values first appear, the same color for the same text in every row.
 */
export function stateData(
  frames: readonly Frame[],
  config: FieldConfig,
  language: string,
  stateWords = true,
  /**
   * A row holds its last state between its own points (state timeline). Without it (status
   * history) a row has a cell only at its own query's points, never a copy at another's time.
   */
  hold = true,
): StateData | null {
  const sources = frames
    .filter((f) => timeField(f) !== undefined && f.fields.some((field) => field.type !== "time"))
    .map((frame) => ({ frame, points: timeOrder(frame) }));
  if (sources.length === 0) {
    return null;
  }
  const all = [...new Set(sources.flatMap((s) => s.points.map((p) => p.time)))].sort(
    (a, b) => a - b,
  );
  // Far more points than pixels: each stretch keeps its last value, so a long result draws as
  // fast as a short one. A state shorter than one stretch can drop out; zooming in shows it.
  const times =
    all.length <= MAX_STATE_POINTS
      ? all
      : Array.from(
          { length: MAX_STATE_POINTS },
          (_, i) =>
            all[
              Math.min(all.length - 1, Math.floor(((i + 1) * all.length) / MAX_STATE_POINTS) - 1)
            ] as number,
        );
  const palette = new Map<string, number>();
  const legend = new Map<string, StateValue>();
  const rows = sources.flatMap(({ frame, points }) => {
    // The frame's row index in effect at each shared time point: its last point at or before it.
    const at: (number | null)[] = [];
    let next = 0;
    for (const time of times) {
      while (next < points.length && (points[next] as { time: number }).time <= time) next++;
      const last = next === 0 ? undefined : (points[next - 1] as { time: number; index: number });
      at.push(last === undefined || (!hold && last.time !== time) ? null : last.index);
    }
    return frame.fields
      .filter((field) => field.type !== "time")
      .map((field) => {
        const options = fieldOptionsFor(field, config);
        const values = at.map((index) => {
          const raw = index === null ? null : field.values[index];
          if (raw === null || raw === undefined) {
            return null;
          }
          const display = displayValue(raw, field.type, options, language);
          const text = displayText(display);
          let colorClass: string;
          const known = stateWords && options.color === undefined ? stateTone(text) : undefined;
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
        return {
          row: { name: displayNameOf(field, options), values },
          named: {
            name: displayNameOf(field, options),
            field,
            ...(frameName(frame) === undefined ? {} : { refId: frameName(frame) as string }),
            fixed: options.displayName !== undefined,
          },
        };
      });
  });
  // Rows of several queries with the same field name are told apart like series (amount (B)).
  const names = distinctSeriesNames(rows.map((r) => r.named));
  return {
    times,
    rows: rows.map((r, i) => ({ ...r.row, name: names[i] ?? r.row.name })),
    legend: [...legend.values()],
  };
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
