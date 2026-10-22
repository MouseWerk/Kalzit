import type { Field, FieldType, Frame, FrameMeta } from "../api/generated/shapes";
import {
  addMonths,
  compareText,
  compile,
  DAY_MS,
  type Detail,
  DetailError,
  detail,
  FIELD_TYPE_OF,
  isoTime,
  numberText,
  parse,
  toCell,
} from "./expr";
import * as stats from "./stats";

/**
 * Analysis steps on frames (docs/api/analysis.md): explicit, ordered and stored with the panel
 * (`transformations`) or the Explore query. The browser runs them for what it shows; the server
 * runs the same steps (`server/src/analysis/steps.rs`) for exports. Both pass the cases of
 * `server/src/analysis/conformance.json`.
 *
 * Pushdown (later): steps run on results already in memory, bounded by the query's row limit.
 * Heavy grouping belongs in the database; a later version moves a leading group, reduce or pivot
 * step into the query for sources that can run it.
 */

export type JoinMode = "inner" | "left" | "outer";
export type Stat = "count" | "sum" | "mean" | "median" | "min" | "max" | "stddev" | "percentile";
export type Agg = "count" | "sum" | "mean" | "median" | "min" | "max" | "stddev" | "first" | "last";
export type Period = "week" | "month" | "year";
export type CompareOutput = "previous" | "difference" | "percent";
export type TrendOutput = "fitted" | "summary";

export const STATS: readonly Stat[] = [
  "count",
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "stddev",
  "percentile",
];
export const AGGS: readonly Agg[] = [
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "count",
  "stddev",
  "first",
  "last",
];

export interface Aggregation {
  field: string;
  op: Agg;
  name?: string;
}

export type StepKind =
  | { type: "calculate"; frame: string; name: string; expression: string }
  | {
      type: "join";
      left: string;
      right: string;
      on: { by: "time" } | { by: "key"; leftField: string; rightField: string };
      mode: JoinMode;
    }
  | { type: "reduce"; frame: string; fields: string[]; stats: Stat[]; percentiles?: number[] }
  | { type: "trend"; frame: string; field: string; x?: string; output: TrendOutput; name?: string }
  | { type: "movingAverage"; frame: string; field: string; window: number; name: string }
  | { type: "correlate"; frame: string; x: string; y: string }
  | {
      type: "compare";
      frame: string;
      field: string;
      time?: string;
      period: Period;
      output: CompareOutput;
      name: string;
    }
  | { type: "group"; frame: string; by: string[]; aggregations: Aggregation[] }
  | { type: "pivot"; frame: string; row: string; column: string; value: string; op: Agg };

export type StepType = StepKind["type"];
export type Step = StepKind & { id: string; disabled?: boolean };

export const STEP_TYPES: readonly StepType[] = [
  "calculate",
  "join",
  "reduce",
  "trend",
  "movingAverage",
  "correlate",
  "compare",
  "group",
  "pivot",
];

/** The server's bounds (server/src/analysis/mod.rs). */
export const MAX_STEPS = 50;
export const MAX_WINDOW = 10_000;
export const MAX_ROWS = 500_000;
export const MAX_COLUMNS = 500;

export interface NamedFrame {
  name: string;
  frame: Frame;
}

/** The frames each step reads. */
export function stepFrames(step: StepKind): string[] {
  return step.type === "join" ? [step.left, step.right] : [step.frame];
}

/** A stored step, or null for anything that is not one; the server checked what it stored. */
export function asStep(value: unknown): Step | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !STEP_TYPES.includes(v.type as StepType)) return null;
  return value as Step;
}

export function asSteps(values: readonly unknown[]): Step[] {
  return values.map(asStep).filter((s): s is Step => s !== null);
}

export interface StepOutcome {
  /** The frames after this step; absent when it failed or was not reached. */
  frames?: NamedFrame[];
  error?: Detail;
  /** Disabled, or after a failed step. */
  skipped: boolean;
}

export interface StepsRun {
  /** The frames after the last step that ran; the error, if any, is in `failed`. */
  frames: NamedFrame[];
  steps: StepOutcome[];
  failed?: { index: number; error: Detail };
}

/** Runs the enabled steps in order; the first failure stops the run. */
export function runSteps(steps: readonly Step[], frames: readonly NamedFrame[]): StepsRun {
  let current = [...frames];
  const outcomes: StepOutcome[] = [];
  let failed: StepsRun["failed"];
  steps.forEach((step, index) => {
    if (failed !== undefined || step.disabled === true) {
      outcomes.push({ skipped: true });
      return;
    }
    try {
      current = apply(step, current);
      outcomes.push({ frames: current, skipped: false });
    } catch (e) {
      const error =
        e instanceof DetailError
          ? e.detail
          : { reason: "internal", params: {}, message: e instanceof Error ? e.message : String(e) };
      failed = { index, error };
      outcomes.push({ error, skipped: false });
    }
  });
  return failed === undefined
    ? { frames: current, steps: outcomes }
    : { frames: current, steps: outcomes, failed };
}

// ---- helpers ----

const wrongType = (field: Field) =>
  detail("steps.field_type", `field ${field.name} (${field.type}) cannot be used here`, {
    field: field.name,
    type: field.type,
  });

function position(frames: readonly NamedFrame[], name: string): number {
  const i = frames.findIndex((f) => f.name === name);
  if (i < 0) {
    throw detail("steps.frame_missing", `there is no table ${name} to work on`, { frame: name });
  }
  return i;
}

function fieldIndex(frame: Frame, name: string): number {
  let found = -1;
  for (let i = 0; i < frame.fields.length; i++) {
    if (frame.fields[i]?.name !== name) continue;
    if (found >= 0) {
      throw detail("steps.field_ambiguous", `several fields are named ${name}`, { field: name });
    }
    found = i;
  }
  if (found < 0) throw detail("steps.field_missing", `there is no field ${name}`, { field: name });
  return found;
}

const fieldAt = (frame: Frame, i: number) => frame.fields[i] as Field;

function numericField(frame: Frame, name: string): Field {
  const f = fieldAt(frame, fieldIndex(frame, name));
  if (f.type !== "number" && f.type !== "int64") throw wrongType(f);
  return f;
}

function firstTimeField(nf: NamedFrame): number {
  const i = nf.frame.fields.findIndex((f) => f.type === "time");
  if (i < 0) {
    throw detail("steps.no_time_field", `table ${nf.name} has no time field`, { frame: nf.name });
  }
  return i;
}

function timeField(nf: NamedFrame, name: string | undefined): number {
  if (name === undefined) return firstTimeField(nf);
  const i = fieldIndex(nf.frame, name);
  const f = fieldAt(nf.frame, i);
  if (f.type !== "time") throw wrongType(f);
  return i;
}

function checkFree(frame: Frame, name: string): void {
  if (frame.fields.some((f) => f.name === name)) {
    throw detail("steps.name_taken", `a field is already named ${name}`, { name });
  }
}

const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** A cell as a number: numbers, int64 digits and times; anything else is empty. */
export function numberAt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && PLAIN_NUMBER.test(value)) {
    const x = Number(value);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

const numbers = (field: Field) => field.values.map(numberAt);
const numCell = (x: number | null) => (x === null || !Number.isFinite(x) ? null : x === 0 ? 0 : x);

function newField(name: string, type: FieldType, values: unknown[]): Field {
  return { name, type, values };
}

function frameOf(fields: Field[], meta: FrameMeta | undefined): Frame {
  return meta === undefined ? { fields } : { fields, meta };
}

const rowsOf = (frame: Frame) => frame.fields[0]?.values.length ?? 0;
const withField = (frame: Frame, field: Field) => frameOf([...frame.fields, field], frame.meta);

/** The text groups and joins compare: numbers as JavaScript writes them, int64 digits. */
function keyOf(value: unknown, type: FieldType): string | null {
  if (value === null || value === undefined) return null;
  if (type === "int64" && typeof value === "string") {
    if (/^[+-]?\d+$/.test(value)) {
      try {
        return BigInt(value).toString();
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value === "number") return numberText(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function keyable(field: Field): void {
  if (field.type === "json") throw wrongType(field);
}

// ---- steps ----

function apply(step: StepKind, frames: NamedFrame[]): NamedFrame[] {
  if (step.type === "join") return join(frames, step);
  const index = position(frames, step.frame);
  const nf = frames[index] as NamedFrame;
  const frame = nf.frame;
  let result: Frame;
  switch (step.type) {
    case "calculate": {
      checkFree(frame, step.name);
      const compiled = compile(parse(step.expression), frame.fields);
      const type = compiled.result === "null" ? "number" : FIELD_TYPE_OF[compiled.result];
      const values = Array.from({ length: rowsOf(frame) }, (_, row) =>
        toCell(compiled.result, compiled.eval(row)),
      );
      result = withField(frame, newField(step.name, type, values));
      break;
    }
    case "reduce":
      result = reduce(frame, step.fields, step.stats, step.percentiles ?? []);
      break;
    case "trend":
      result = trend(nf, step.field, step.x, step.output, step.name);
      break;
    case "movingAverage": {
      checkFree(frame, step.name);
      const f = numericField(frame, step.field);
      const values = stats.movingAverage(numbers(f), step.window).map(numCell);
      result = withField(frame, newField(step.name, "number", values));
      break;
    }
    case "correlate": {
      const fx = numbers(numericField(frame, step.x));
      const fy = numbers(numericField(frame, step.y));
      const points: [number, number][] = [];
      fx.forEach((a, i) => {
        const b = fy[i] ?? null;
        if (a !== null && b !== null) points.push([a, b]);
      });
      result = frameOf(
        [
          newField("x", "string", [step.x]),
          newField("y", "string", [step.y]),
          newField("r", "number", [numCell(stats.correlation(points))]),
          newField("n", "number", [points.length]),
        ],
        frame.meta,
      );
      break;
    }
    case "compare":
      result = compare(nf, step);
      break;
    case "group":
      result = group(frame, step.by, step.aggregations);
      break;
    case "pivot":
      result = pivot(frame, step.row, step.column, step.value, step.op);
      break;
  }
  const next = [...frames];
  next[index] = { name: nf.name, frame: result };
  return next;
}

function reduce(frame: Frame, fields: string[], wanted: Stat[], percentiles: number[]): Frame {
  const columns: [string, unknown[]][] = [];
  for (const s of wanted) {
    if (s === "percentile") {
      for (const p of percentiles) columns.push([`p${numberText(p)}`, []]);
    } else {
      columns.push([s, []]);
    }
  }
  const names: string[] = [];
  for (const name of fields) {
    const f = numericField(frame, name);
    names.push(name);
    const values = numbers(f).filter((v): v is number => v !== null);
    const s = stats.sorted(values);
    let c = 0;
    const push = (v: unknown) => {
      columns[c++]?.[1].push(v);
    };
    for (const st of wanted) {
      switch (st) {
        case "count":
          push(values.length);
          break;
        case "sum":
          push(numCell(values.length === 0 ? null : stats.sum(values)));
          break;
        case "mean":
          push(numCell(stats.mean(values)));
          break;
        case "median":
          push(numCell(stats.percentile(s, 50)));
          break;
        case "min":
          push(numCell(stats.min(values)));
          break;
        case "max":
          push(numCell(stats.max(values)));
          break;
        case "stddev":
          push(numCell(stats.stddev(values)));
          break;
        case "percentile":
          for (const p of percentiles) push(numCell(stats.percentile(s, p)));
          break;
      }
    }
  }
  return frameOf(
    [
      newField("field", "string", names),
      ...columns.map(([name, values]) => newField(name, "number", values)),
    ],
    frame.meta,
  );
}

function trend(
  nf: NamedFrame,
  field: string,
  x: string | undefined,
  output: TrendOutput,
  name: string | undefined,
): Frame {
  const frame = nf.frame;
  const y = numbers(numericField(frame, field));
  let xs: (number | null)[];
  let overTime: boolean;
  if (x !== undefined) {
    const f = fieldAt(frame, fieldIndex(frame, x));
    if (f.type !== "number" && f.type !== "int64" && f.type !== "time") throw wrongType(f);
    xs = numbers(f);
    overTime = f.type === "time";
  } else {
    const f = frame.fields.find((t) => t.type === "time");
    xs = f === undefined ? Array.from({ length: rowsOf(frame) }, (_, i) => i) : numbers(f);
    overTime = f !== undefined;
  }
  const points: [number, number][] = [];
  xs.forEach((a, i) => {
    const b = y[i] ?? null;
    if (a !== null && b !== null) points.push([a, b]);
  });
  const line = stats.regression(points);
  if (output === "fitted") {
    const n = name ?? "trend";
    checkFree(frame, n);
    const values = xs.map((v) =>
      numCell(line === null || v === null ? null : line.intercept + line.slope * v),
    );
    return withField(frame, newField(n, "number", values));
  }
  const per = overTime ? DAY_MS : 1;
  return frameOf(
    [
      newField("field", "string", [field]),
      newField("slope", "number", [numCell(line === null ? null : line.slope * per)]),
      newField("intercept", "number", [numCell(line?.intercept ?? null)]),
      newField("r2", "number", [numCell(line?.r2 ?? null)]),
      newField("n", "number", [points.length]),
    ],
    frame.meta,
  );
}

function compare(nf: NamedFrame, step: Extract<StepKind, { type: "compare" }>): Frame {
  const frame = nf.frame;
  checkFree(frame, step.name);
  const values = numbers(numericField(frame, step.field));
  const times = numbers(fieldAt(frame, timeField(nf, step.time)));
  const at = new Map<number, number>();
  times.forEach((t, i) => {
    const v = values[i] ?? null;
    if (t !== null && v !== null && !at.has(Math.trunc(t))) at.set(Math.trunc(t), v);
  });
  const earlier = (t: number) =>
    step.period === "week"
      ? t - 7 * DAY_MS
      : step.period === "month"
        ? addMonths(t, -1)
        : addMonths(t, -12);
  const out = times.map((t, i) => {
    const v = values[i] ?? null;
    const previous = t === null ? null : (at.get(Math.trunc(earlier(t))) ?? null);
    switch (step.output) {
      case "previous":
        return numCell(previous);
      case "difference":
        return numCell(v === null || previous === null ? null : v - previous);
      default:
        return numCell(
          v === null || previous === null || previous === 0
            ? null
            : ((v - previous) / Math.abs(previous)) * 100,
        );
    }
  });
  return withField(frame, newField(step.name, "number", out));
}

/** Rows grouped by a key, in the order each key first appears. */
function groups(rows: number, keyOfRow: (row: number) => string): number[][] {
  const index = new Map<string, number>();
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const key = keyOfRow(r);
    let g = index.get(key);
    if (g === undefined) {
      g = out.length;
      index.set(key, g);
      out.push([]);
    }
    out[g]?.push(r);
  }
  return out;
}

/** One group key for several cells; empty cells are their own value. */
const joinKeys = (keys: (string | null)[]) => JSON.stringify(keys);

function aggType(field: Field, op: Agg): FieldType {
  const t = field.type;
  if (op === "count") return "number";
  if (op === "first" || op === "last") return t;
  if (
    (op === "min" || op === "max") &&
    (t === "number" || t === "int64" || t === "time" || t === "string")
  ) {
    return t;
  }
  if (
    (op === "sum" || op === "mean" || op === "median" || op === "stddev") &&
    (t === "number" || t === "int64")
  ) {
    return "number";
  }
  throw wrongType(field);
}

function aggregate(field: Field, op: Agg, rows: readonly number[]): unknown {
  const cells = rows.map((r) => field.values[r]).filter((v) => v !== null && v !== undefined);
  const nums = () =>
    rows.map((r) => numberAt(field.values[r])).filter((v): v is number => v !== null);
  switch (op) {
    case "count":
      return cells.length;
    case "first":
      return cells[0] ?? null;
    case "last":
      return cells.at(-1) ?? null;
    case "sum": {
      const v = nums();
      return numCell(v.length === 0 ? null : stats.sum(v));
    }
    case "mean":
      return numCell(stats.mean(nums()));
    case "median":
      return numCell(stats.percentile(stats.sorted(nums()), 50));
    case "stddev":
      return numCell(stats.stddev(nums()));
    default: {
      const less = (a: unknown, b: unknown): boolean => {
        if (field.type === "int64") {
          try {
            return BigInt(a as string) < BigInt(b as string);
          } catch {
            return false;
          }
        }
        if (field.type === "string") return compareText(String(a), String(b)) < 0;
        return (numberAt(a) as number) < (numberAt(b) as number);
      };
      let best: unknown = null;
      for (const v of cells) {
        if (field.type !== "string" && numberAt(v) === null) continue;
        if (best === null || (op === "min" ? less(v, best) : less(best, v))) best = v;
      }
      return best;
    }
  }
}

function copyField(f: Field, values: unknown[]): Field {
  const out: Field = { name: f.name, type: f.type, values };
  if (f.unit !== undefined) out.unit = f.unit;
  if (f.labels !== undefined) out.labels = f.labels;
  return out;
}

function group(frame: Frame, by: string[], aggregations: Aggregation[]): Frame {
  const byFields = by.map((n) => fieldAt(frame, fieldIndex(frame, n)));
  for (const f of byFields) keyable(f);
  const names = [...by];
  const plan = aggregations.map((a) => {
    const f = fieldAt(frame, fieldIndex(frame, a.field));
    const t = aggType(f, a.op);
    const name = a.name ?? `${a.op}(${a.field})`;
    if (names.includes(name)) {
      throw detail("steps.name_taken", `a field is already named ${name}`, { name });
    }
    names.push(name);
    return { f, op: a.op, t, name };
  });
  const rows = groups(rowsOf(frame), (r) =>
    joinKeys(byFields.map((f) => keyOf(f.values[r], f.type))),
  );
  const fields = byFields.map((f) =>
    copyField(
      f,
      rows.map((g) => f.values[g[0] as number]),
    ),
  );
  for (const { f, op, t, name } of plan) {
    const field = newField(
      name,
      t,
      rows.map((g) => aggregate(f, op, g)),
    );
    if (op !== "count" && f.unit !== undefined) field.unit = f.unit;
    fields.push(field);
  }
  return frameOf(fields, frame.meta);
}

function pivot(frame: Frame, row: string, column: string, value: string, op: Agg): Frame {
  const rf = fieldAt(frame, fieldIndex(frame, row));
  const cf = fieldAt(frame, fieldIndex(frame, column));
  const vf = fieldAt(frame, fieldIndex(frame, value));
  keyable(rf);
  keyable(cf);
  const t = aggType(vf, op);
  const n = rowsOf(frame);
  const rowGroups = groups(n, (r) => joinKeys([keyOf(rf.values[r], rf.type)]));
  const colGroups = groups(n, (r) => joinKeys([keyOf(cf.values[r], cf.type)]));
  if (colGroups.length > MAX_COLUMNS) {
    throw detail("steps.too_many_columns", `the pivot would make more than ${MAX_COLUMNS} fields`, {
      max: MAX_COLUMNS,
    });
  }
  const columnOf = new Array<number>(n).fill(0);
  colGroups.forEach((g, c) => {
    for (const r of g) columnOf[r] = c;
  });
  const cells = new Map<string, number[]>();
  rowGroups.forEach((rows, g) => {
    for (const r of rows) {
      const key = `${g}:${columnOf[r]}`;
      const list = cells.get(key);
      if (list === undefined) cells.set(key, [r]);
      else list.push(r);
    }
  });
  const fields: Field[] = [
    copyField(
      rf,
      rowGroups.map((g) => rf.values[g[0] as number]),
    ),
  ];
  colGroups.forEach((g, c) => {
    const first = cf.values[g[0] as number];
    const ms = numberAt(first);
    const name =
      cf.type === "time" && ms !== null
        ? isoTime(Math.trunc(ms))
        : (keyOf(first, cf.type) ?? "null");
    if (fields.some((f) => f.name === name)) {
      throw detail("steps.name_taken", `a field is already named ${name}`, { name });
    }
    const field = newField(
      name,
      t,
      rowGroups.map((_, gi) => aggregate(vf, op, cells.get(`${gi}:${c}`) ?? [])),
    );
    if (op !== "count" && vf.unit !== undefined) field.unit = vf.unit;
    fields.push(field);
  });
  return frameOf(fields, frame.meta);
}

function sameFamily(a: FieldType, b: FieldType): boolean {
  const numeric = (t: FieldType) => t === "number" || t === "int64";
  return (numeric(a) && numeric(b)) || (a === b && a !== "json");
}

function convertKey(value: unknown, from: FieldType, to: FieldType): unknown {
  if (from === "int64" && to === "number") return numCell(numberAt(value));
  if (from === "number" && to === "int64") return keyOf(value, from);
  return value ?? null;
}

function join(frames: NamedFrame[], step: Extract<StepKind, { type: "join" }>): NamedFrame[] {
  const li = position(frames, step.left);
  const ri = position(frames, step.right);
  const l = frames[li] as NamedFrame;
  const r = frames[ri] as NamedFrame;
  const [lk, rk] =
    step.on.by === "time"
      ? [firstTimeField(l), firstTimeField(r)]
      : [fieldIndex(l.frame, step.on.leftField), fieldIndex(r.frame, step.on.rightField)];
  const lkf = fieldAt(l.frame, lk);
  const rkf = fieldAt(r.frame, rk);
  keyable(lkf);
  keyable(rkf);
  if (!sameFamily(lkf.type, rkf.type)) {
    throw detail(
      "steps.key_types",
      `${lkf.name} (${lkf.type}) cannot be matched with ${rkf.name} (${rkf.type})`,
      { left: lkf.type, right: rkf.type },
    );
  }
  const byKey = new Map<string, number[]>();
  rkf.values.forEach((v, row) => {
    const k = keyOf(v, rkf.type);
    if (k === null) return;
    const list = byKey.get(k);
    if (list === undefined) byKey.set(k, [row]);
    else list.push(row);
  });
  const tooMany = () =>
    detail("steps.too_many_rows", `the join would make more than ${MAX_ROWS} rows`, {
      max: MAX_ROWS,
    });
  const pairs: [number | null, number | null][] = [];
  const matched = new Array<boolean>(rowsOf(r.frame)).fill(false);
  lkf.values.forEach((v, row) => {
    const k = keyOf(v, lkf.type);
    const hits = k === null ? undefined : byKey.get(k);
    if (hits !== undefined) {
      for (const j of hits) {
        matched[j] = true;
        pairs.push([row, j]);
      }
    } else if (step.mode !== "inner") {
      pairs.push([row, null]);
    }
    if (pairs.length > MAX_ROWS) throw tooMany();
  });
  if (step.mode === "outer") {
    matched.forEach((m, j) => {
      if (!m) pairs.push([null, j]);
    });
    if (pairs.length > MAX_ROWS) throw tooMany();
  }
  const keyCell = ([i, j]: [number | null, number | null]): unknown =>
    i !== null
      ? (lkf.values[i] ?? null)
      : j !== null
        ? convertKey(rkf.values[j], rkf.type, lkf.type)
        : null;
  if (step.on.by === "time") {
    const keyed = pairs.map((p) => ({ p, t: numberAt(keyCell(p)) }));
    keyed.sort((a, b) =>
      a.t !== null && b.t !== null ? a.t - b.t : a.t !== null ? -1 : b.t !== null ? 1 : 0,
    );
    pairs.splice(0, pairs.length, ...keyed.map((k) => k.p));
  }
  const fields: Field[] = [copyField(lkf, pairs.map(keyCell))];
  for (const [nf, key, left] of [
    [l, lk, true],
    [r, rk, false],
  ] as const) {
    nf.frame.fields.forEach((f, i) => {
      if (i === key) return;
      const values = pairs.map((p) => {
        const row = left ? p[0] : p[1];
        return row === null ? null : (f.values[row] ?? null);
      });
      fields.push(copyField({ ...f, name: `${nf.name}.${f.name}` }, values));
    });
  }
  let meta: FrameMeta | undefined;
  if (l.frame.meta !== undefined || r.frame.meta !== undefined) {
    meta = {
      rowsTruncated:
        (l.frame.meta?.rowsTruncated ?? false) || (r.frame.meta?.rowsTruncated ?? false),
      notices: [...(l.frame.meta?.notices ?? []), ...(r.frame.meta?.notices ?? [])],
    };
  }
  const next = [...frames];
  next[li] = { name: l.name, frame: frameOf(fields, meta) };
  next.splice(ri, 1);
  return next;
}

export { DetailError };
