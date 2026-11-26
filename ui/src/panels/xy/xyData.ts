import type { Field, Frame } from "../../api/generated/shapes";
import {
  displayNameOf,
  type FieldConfig,
  type FieldOptions,
  fieldOptionsFor,
} from "../fieldConfig/fieldConfig";
import { isNumeric, toNumber } from "../frame";
import { MONO_CLASS, seriesColor } from "../timeseries/styles";

/** Points the XY chart draws one by one; above this it samples evenly and says so. */
export const MAX_XY_POINTS = 12_000;
/** Colours of series split by a field's values; the rest is one series "Others". */
export const MAX_XY_SERIES = 8;
/** Point size bounds in px, as the server checks them. */
export const XY_SIZE = { min: 1, max: 40 } as const;

export type XYMapping = "auto" | "manual";
export type XYShow = "points" | "lines" | "both";

export interface XYFieldChoice {
  mapping: XYMapping;
  /** X and Y by name, for the manual mapping. */
  x?: string;
  y?: string;
  /** One series per value of this field; absent: one series per Y field. */
  seriesBy?: string;
  /** A number field that sets each point's size between `sizeMin` and `sizeMax`. */
  sizeBy?: string;
  /** A number field that colours each point along a ramp; absent: the series' colour. */
  colorBy?: string;
}

export interface XYSizes {
  sizeMin: number;
  sizeMax: number;
}

/** One series as drawn: its points in row order. */
export interface XYSeries {
  name: string;
  colorClass: string;
  /** Field options of its Y field, for the value format. */
  options: FieldOptions;
  yField: Field;
  frame: number;
  xs: number[];
  ys: number[];
  /** The row of each point in its frame. */
  rows: number[];
  /** The series of the values beyond the first seven ("Others"). */
  others?: boolean;
}

export interface XYData {
  xField: Field;
  xOptions: FieldOptions;
  yOptions: FieldOptions;
  series: XYSeries[];
  /** Points over all series. */
  total: number;
  /** Over every point, drawn or not: the axes cover them all. */
  x: { min: number; max: number };
  y: { min: number; max: number };
  sizeField?: Field;
  sizeExtent?: { min: number; max: number };
  colorField?: Field;
  colorExtent?: { min: number; max: number };
}

/** Why there is nothing to draw: no frame with two number fields, or the named fields are missing. */
export type XYProblem =
  | { kind: "oneNumber"; field: string }
  | { kind: "noNumbers" }
  | { kind: "missing"; field: string };

const numberFields = (frame: Frame) => frame.fields.filter((f) => isNumeric(f.type));

/** A field of the frame by name, if it is a number field. */
function numberField(frame: Frame, name: string | undefined): Field | undefined {
  return name === undefined ? undefined : numberFields(frame).find((f) => f.name === name);
}

/**
 * The X field and the Y fields of a frame. Auto: the first number field is X, every further one
 * a Y series (fields that set size or colour excepted). By hand: the named fields.
 */
export function pickFields(
  frame: Frame,
  choice: XYFieldChoice,
): { x: Field; ys: Field[] } | XYProblem {
  const numbers = numberFields(frame);
  if (choice.mapping === "manual") {
    const x = numberField(frame, choice.x);
    if (x === undefined) return { kind: "missing", field: choice.x ?? "" };
    const y = numberField(frame, choice.y);
    if (y === undefined) return { kind: "missing", field: choice.y ?? "" };
    return { x, ys: [y] };
  }
  const used = new Set([choice.sizeBy, choice.colorBy]);
  const [x, ...rest] = numbers;
  if (x === undefined) return { kind: "noNumbers" };
  const ys = rest.filter((f) => !used.has(f.name));
  if (ys.length === 0) return { kind: "oneNumber", field: x.name };
  return { x, ys };
}

/** A cell of the field that splits series as its key text. */
function keyText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/**
 * The values of the series field that get their own series: all of them up to eight, else the
 * seven most frequent (ties in the order they first appear), the rest going to "Others".
 */
export function seriesKeys(values: readonly unknown[]): { keys: string[]; others: boolean } {
  const counts = new Map<string, number>();
  for (const v of values) {
    const k = keyText(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const all = [...counts.keys()];
  if (all.length <= MAX_XY_SERIES) return { keys: all, others: false };
  const ranked = all
    .map((k, i) => ({ k, i, n: counts.get(k) ?? 0 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, MAX_XY_SERIES - 1)
    .sort((a, b) => a.i - b.i);
  return { keys: ranked.map((r) => r.k), others: true };
}

function extentOf(values: Iterable<number>): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : undefined;
}

/**
 * The series of an XY chart: every frame's rows as points of X against each Y field, split per
 * value of the series field when one is set. Rows without an X or a Y value are no points. The
 * panel draws what the frames hold, in their order; nothing is sorted, grouped or converted.
 */
export function buildXY(
  frames: readonly Frame[],
  choice: XYFieldChoice,
  config: FieldConfig,
  others: string,
): XYData | XYProblem {
  let firstProblem: XYProblem | undefined;
  const series: XYSeries[] = [];
  let xField: Field | undefined;
  let sizeField: Field | undefined;
  let colorField: Field | undefined;
  const sizes: number[] = [];
  const colors: number[] = [];
  frames.forEach((frame, frameIndex) => {
    const picked = pickFields(frame, choice);
    if ("kind" in picked) {
      firstProblem ??= picked;
      return;
    }
    xField ??= picked.x;
    const size = numberField(frame, choice.sizeBy);
    const color = numberField(frame, choice.colorBy);
    sizeField ??= size;
    colorField ??= color;
    const by =
      choice.seriesBy === undefined
        ? undefined
        : frame.fields.find((f) => f.name === choice.seriesBy && f.type !== "json");
    const split = by === undefined ? null : seriesKeys(by.values);
    const xs = picked.x.values.map(toNumber);
    for (const yField of picked.ys) {
      const options = fieldOptionsFor(yField, config);
      const yName = displayNameOf(yField, options);
      const groups =
        split === null
          ? [{ name: yName, key: null as string | null }]
          : [
              ...split.keys.map((k) => ({ name: k, key: k as string | null })),
              ...(split.others ? [{ name: others, key: null }] : []),
            ];
      const start = series.length;
      for (const g of groups) {
        series.push({
          name:
            split !== null && picked.ys.length > 1 ? `${yName} · ${g.name}` : (g.name as string),
          colorClass: "",
          options,
          yField,
          frame: frameIndex,
          xs: [],
          ys: [],
          rows: [],
          ...(split !== null && g.key === null ? { others: true } : {}),
        });
      }
      const index = new Map(split?.keys.map((k, i) => [k, start + i]));
      const othersIndex = split?.others === true ? start + split.keys.length : -1;
      for (let row = 0; row < xs.length; row++) {
        const x = xs[row];
        const y = toNumber(yField.values[row]);
        if (x === null || x === undefined || y === null) continue;
        const target =
          split === null
            ? start
            : (index.get(keyText(by?.values[row])) ?? (othersIndex === -1 ? -1 : othersIndex));
        const s = series[target];
        if (s === undefined) continue;
        s.xs.push(x);
        s.ys.push(y);
        s.rows.push(row);
        if (size !== undefined) {
          const v = toNumber(size.values[row]);
          if (v !== null) sizes.push(v);
        }
        if (color !== undefined) {
          const v = toNumber(color.values[row]);
          if (v !== null) colors.push(v);
        }
      }
    }
  });
  if (xField === undefined) {
    return firstProblem ?? { kind: "noNumbers" };
  }
  // Colours: a series of its own field keeps its colour; split series take the palette in order,
  // "Others" a neutral one.
  series.forEach((s, i) => {
    s.colorClass = s.others
      ? MONO_CLASS
      : seriesColor(choice.seriesBy === undefined ? s.options : {}, i, series.length, false)
          .colorClass;
  });
  const all = series.flatMap((s) => s.xs);
  const x = extentOf(all) ?? { min: 0, max: 1 };
  const y = extentOf(series.flatMap((s) => s.ys)) ?? { min: 0, max: 1 };
  const data: XYData = {
    xField,
    xOptions: fieldOptionsFor(xField, config),
    yOptions: series[0]?.options ?? config.defaults,
    series,
    total: all.length,
    x,
    y,
  };
  const sizeExtent = extentOf(sizes);
  if (sizeField !== undefined && sizeExtent !== undefined) {
    data.sizeField = sizeField;
    data.sizeExtent = sizeExtent;
  }
  const colorExtent = extentOf(colors);
  if (colorField !== undefined && colorExtent !== undefined) {
    data.colorField = colorField;
    data.colorExtent = colorExtent;
  }
  return data;
}

/**
 * Which of `count` points to draw when there are more than `max`: evenly spread indexes, first
 * and every `count / max`-th, ascending. Null when all fit.
 */
export function sampleEvenly(count: number, max: number = MAX_XY_POINTS): Int32Array | null {
  if (count <= max) return null;
  const picked = new Int32Array(max);
  for (let j = 0; j < max; j++) {
    picked[j] = Math.floor((j * count) / max);
  }
  return picked;
}

/** The radius of a point whose size value is `value`, linear from `sizeMin` to `sizeMax` px. */
export function pointSize(
  value: number | null,
  extent: { min: number; max: number } | undefined,
  { sizeMin, sizeMax }: XYSizes,
): number {
  if (value === null || extent === undefined) return sizeMin;
  const span = extent.max - extent.min;
  const share = span > 0 ? (value - extent.min) / span : 0.5;
  return sizeMin + Math.min(Math.max(share, 0), 1) * (sizeMax - sizeMin);
}

/** Steps of the colour ramp (`--ramp-blues-1` to `-5`). */
export const COLOR_STEPS = 5;

/** The ramp step (1 to 5) of a colour value, light for the smallest, dark for the largest. */
export function colorStep(value: number | null, extent: { min: number; max: number } | undefined) {
  if (value === null || extent === undefined) return 1;
  const span = extent.max - extent.min;
  const share = span > 0 ? (value - extent.min) / span : 0.5;
  return Math.min(COLOR_STEPS, Math.floor(Math.min(Math.max(share, 0), 1) * COLOR_STEPS) + 1);
}

export interface DensityCell {
  column: number;
  row: number;
  count: number;
}

/**
 * Every point counted into a grid of `columns` by `rows` cells over the extents, for the
 * density view: it covers all points, not only the drawn ones.
 */
export function densityGrid(
  series: readonly Pick<XYSeries, "xs" | "ys">[],
  x: { min: number; max: number },
  y: { min: number; max: number },
  columns: number,
  rows: number,
): { cells: DensityCell[]; max: number } {
  const counts = new Map<number, number>();
  const xSpan = x.max - x.min || 1;
  const ySpan = y.max - y.min || 1;
  for (const s of series) {
    for (let i = 0; i < s.xs.length; i++) {
      const px = ((s.xs[i] as number) - x.min) / xSpan;
      const py = ((s.ys[i] as number) - y.min) / ySpan;
      if (px < 0 || px > 1 || py < 0 || py > 1) continue;
      const c = Math.min(columns - 1, Math.floor(px * columns));
      const r = Math.min(rows - 1, Math.floor(py * rows));
      const key = r * columns + c;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let max = 0;
  const cells: DensityCell[] = [];
  for (const [key, count] of counts) {
    cells.push({ column: key % columns, row: Math.floor(key / columns), count });
    if (count > max) max = count;
  }
  return { cells, max };
}
