import type { StepKind } from "../../analysis/steps";
import type { Field, Frame } from "../../api/generated/shapes";
import {
  displayNameOf,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
  fieldOptionsFor,
} from "../fieldConfig/fieldConfig";
import { distinctSeriesNames, frameName, isNumeric, toNumber } from "../frame";
import type { Series } from "../timeseries/series";

/** Rows a Trend panel draws at most (docs/design/blueprint/XYMapTrend.dc.html, frame 11). */
export const MAX_TREND_ROWS = 100_000;

/** Whether X values ascend: strictly, with a value that falls back, or with a value repeated. */
export type Ascent =
  | { kind: "ascending" }
  /** Row `row` (0-based) has `value`, below the row before it. */
  | { kind: "falls"; row: number; value: number }
  /** `value` is there in `count` rows. */
  | { kind: "repeats"; value: number; count: number };

/**
 * Whether the X values ascend strictly. Empty cells are no points and are skipped. The first
 * value that falls back wins over a repeated one: sorting comes before grouping.
 */
export function ascent(values: readonly unknown[]): Ascent {
  let previous: number | null = null;
  let repeated: { value: number; count: number } | null = null;
  for (let row = 0; row < values.length; row++) {
    const x = toNumber(values[row]);
    if (x === null) continue;
    if (previous !== null && x < previous) {
      return { kind: "falls", row, value: x };
    }
    if (previous !== null && x === previous && repeated === null) {
      repeated = { value: x, count: 0 };
    }
    previous = x;
  }
  if (repeated !== null) {
    const value = repeated.value;
    const count = values.filter((v) => toNumber(v) === value).length;
    return { kind: "repeats", value, count };
  }
  return { kind: "ascending" };
}

/** What keeps a frame from being drawn as a trend, with what the hint needs to say it. */
export type TrendIssue =
  | { kind: "falls"; field: string; row: number; rows: number; value: number }
  | { kind: "repeats"; field: string; value: number; count: number }
  | { kind: "text"; field: string; example: string }
  | { kind: "missing"; field: string }
  | { kind: "noSeries"; field: string }
  | { kind: "tooMany"; rows: number };

/**
 * The X field of a frame. Named: that field. Auto: the first number field whose values ascend
 * strictly and that leaves another number field to draw; else the first number field. A frame
 * with a text field and no second number has its text field as X, which the hint then names.
 */
export function trendX(frame: Frame, name?: string): Field | undefined {
  if (name !== undefined) return frame.fields.find((f) => f.name === name);
  const numbers = frame.fields.filter((f) => isNumeric(f.type));
  if (numbers.length >= 2) {
    return numbers.find((f) => ascent(f.values).kind === "ascending") ?? numbers[0];
  }
  return frame.fields.find((f) => f.type === "string") ?? numbers[0];
}

/** Whether the frame can be drawn as a trend over `x`, or what is in the way. */
export function trendIssue(frame: Frame, x: Field | undefined, name?: string): TrendIssue | null {
  if (x === undefined) return { kind: "missing", field: name ?? "" };
  if (!isNumeric(x.type)) {
    const example = x.values.find((v) => v !== null && v !== undefined);
    return { kind: "text", field: x.name, example: example === undefined ? "" : String(example) };
  }
  if (!frame.fields.some((f) => f !== x && isNumeric(f.type))) {
    return { kind: "noSeries", field: x.name };
  }
  if (x.values.length > MAX_TREND_ROWS) return { kind: "tooMany", rows: x.values.length };
  const a = ascent(x.values);
  if (a.kind === "falls") {
    return { kind: "falls", field: x.name, row: a.row, rows: x.values.length, value: a.value };
  }
  if (a.kind === "repeats") {
    return { kind: "repeats", field: x.name, value: a.value, count: a.count };
  }
  return null;
}

/**
 * The visible step that makes the frame fit, if there is one: sorting by X when a value falls
 * back, grouping by X with the mean of every other number field when values repeat.
 */
export function fixStep(frame: Frame, issue: TrendIssue): StepKind | null {
  const refId = frameName(frame) ?? "A";
  if (issue.kind === "falls") {
    return { type: "sort", frame: refId, by: [{ field: issue.field }] };
  }
  if (issue.kind === "repeats") {
    return {
      type: "group",
      frame: refId,
      by: [issue.field],
      aggregations: frame.fields
        .filter((f) => f.name !== issue.field && isNumeric(f.type))
        .map((f) => ({ field: f.name, op: "mean" as const, name: f.name })),
    };
  }
  return null;
}

export interface TrendData {
  series: Series[];
  /** The X field of the first frame, for the axis format. */
  x: Field;
  extent: { min: number; max: number };
}

/**
 * Every number field besides X becomes one series over X, named like a time series' series.
 * Only frames without an issue are drawn; the first issue is returned for the hint.
 */
export function buildTrend(
  frames: readonly Frame[],
  name: string | undefined,
  config: FieldConfig = EMPTY_FIELD_CONFIG,
): { data: TrendData | null; issue: { frame: Frame; issue: TrendIssue } | null } {
  const series: Series[] = [];
  const refIds: (string | undefined)[] = [];
  let firstX: Field | undefined;
  let issue: { frame: Frame; issue: TrendIssue } | null = null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const x = trendX(frame, name);
    const problem = trendIssue(frame, x, name);
    if (problem !== null || x === undefined) {
      issue ??= problem === null ? null : { frame, issue: problem };
      continue;
    }
    firstX ??= x;
    const count = x.values.length;
    const times = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v = toNumber(x.values[i]);
      times[i] = v ?? Number.NaN;
      if (v !== null) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    for (const field of frame.fields) {
      if (field === x || !isNumeric(field.type)) continue;
      const values = new Float64Array(count);
      for (let i = 0; i < count; i++) values[i] = toNumber(field.values[i]) ?? Number.NaN;
      const options = fieldOptionsFor(field, config);
      series.push({ name: displayNameOf(field, options), times, values, field, options });
      refIds.push(frameName(frame));
    }
  }
  if (firstX === undefined || series.length === 0 || !Number.isFinite(min)) {
    return { data: null, issue };
  }
  const names = distinctSeriesNames(
    series.map((s, i) => ({
      name: s.name,
      field: s.field as Field,
      ...(refIds[i] === undefined ? {} : { refId: refIds[i] }),
      fixed: s.options?.displayName !== undefined,
    })),
  );
  return {
    data: {
      series: series.map((s, i) => ({ ...s, name: names[i] ?? s.name })),
      x: firstX,
      extent: max > min ? { min, max } : { min: min - 1, max: max + 1 },
    },
    issue,
  };
}
