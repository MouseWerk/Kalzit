import type {
  DocumentSet,
  ErrorBody,
  Field,
  FieldType,
  Frame,
  FrameMeta,
  GraphSet,
  RanIn,
} from "../api/generated/shapes";
import {
  addMonths,
  type Calendar,
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
  parseNumber,
  toCell,
  UTC_CALENDAR,
} from "./expr";
import { applyGraphStep, type GraphRows, type GraphStepKind } from "./graphSteps";
import { type ProjectionColumn, projectDocuments } from "./projection";
import * as stats from "./stats";

/**
 * Analysis steps on frames (docs/api/settings-dashboards.md, "Analysis steps"): explicit, ordered and stored with the panel
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
  | { type: "pivot"; frame: string; row: string; column: string; value: string; op: Agg }
  /**
   * The projection of the `documents` result of `frame` into a frame (docs/PLAN.md, section 1);
   * the documents UI edits it, the steps after it work on the frame it makes. With `rows`, the
   * nodes or edges of a `graph` result ("In Tabelle umwandeln"), optionally only nodes with
   * `label` or edges of `edgeType`.
   */
  | {
      type: "toFrame";
      frame: string;
      columns: ProjectionColumn[];
      rows?: GraphRows;
      label?: string;
      edgeType?: string;
    }
  /** Graph steps (graphSteps.ts): they read a graph and make a frame or a smaller graph. */
  | GraphStepKind;

export type StepType = StepKind["type"];
export type Step = StepKind & { id: string; disabled?: boolean };
/** Kept for readers of this module; every step has the same form. */
export type AnalysisStep = Step;
export type ProjectionStep = Extract<Step, { type: "toFrame" }>;

/** A projection of documents; a projection of a graph (`rows`) is a graph step. */
export const isProjection = (step: Step): step is ProjectionStep =>
  step.type === "toFrame" && step.rows === undefined;

export const GRAPH_STEP_TYPES = [
  "countLabels",
  "countEdgeTypes",
  "degreeDistribution",
  "topDegree",
  "sharedNeighbours",
] as const satisfies readonly StepType[];

/**
 * Whether the step reads a graph. Graph steps run with their query, in the database where the
 * source can, else on the server (docs/api/datasources.md, "Graph steps").
 */
export function isGraphStep(step: StepKind): boolean {
  return (
    (GRAPH_STEP_TYPES as readonly string[]).includes(step.type) ||
    (step.type === "toFrame" && step.rows !== undefined)
  );
}

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
/** Cells (rows times fields) one step may produce, checked before it builds them. */
export const MAX_CELLS = 5_000_000;
/** Text (UTF-16 units) the steps of one run may make: calculated text and the copies a join makes. */
export const MAX_RUN_TEXT_UNITS = 64 * 1024 * 1024;

/** The run's budget, the same as the server's (server/src/analysis/steps.rs, `Control`). */
interface Budget {
  textLeft: number;
  maxCells: number;
  /** The calendar calculated fields read times in. */
  calendar: Calendar;
}

function checkCells(budget: Budget, rows: number, fields: number): void {
  const max = budget.maxCells;
  if (rows * fields > max) {
    throw detail("steps.too_many_cells", `the step would make more than ${max} cells`, { max });
  }
}

function spendText(budget: Budget, units: number): void {
  if (units > budget.textLeft) {
    throw detail(
      "steps.too_much_text",
      `the steps would make more than ${MAX_RUN_TEXT_UNITS} characters of text`,
      { max: MAX_RUN_TEXT_UNITS },
    );
  }
  budget.textLeft -= units;
}

const textUnits = (v: unknown) => (typeof v === "string" ? v.length : 0);

export interface NamedFrame {
  name: string;
  frame: Frame;
}

export interface NamedGraph {
  name: string;
  graph: GraphSet;
}

/**
 * A query's result as the steps read it: a frame, documents a projection may turn into one, or a
 * graph the graph steps read.
 */
export type NamedInput = NamedFrame | { name: string; documents: DocumentSet } | NamedGraph;

/** Where a graph step ran on the server's side, and why it failed there. */
export interface ServerStep {
  ranIn: RanIn;
  error?: ErrorBody | undefined;
}

/**
 * What the server did with the graph steps (`steps` of a query's answer): where each ran, by step
 * id. `results` holds each query's result after them when the inputs are the queries' own
 * results (Explore), taken at the last step the server ran; without it, the inputs already are
 * those results and the steps pass.
 */
export interface ServerSteps {
  ran: ReadonlyMap<string, ServerStep>;
  results?: ReadonlyMap<string, NamedInput>;
}

/** The frames each step reads. */
export function stepFrames(step: StepKind): string[] {
  return step.type === "join" ? [step.left, step.right] : [step.frame];
}

/** A stored step, or null for anything that is not one; the server checked what it stored. */
export function asStep(value: unknown): Step | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const known =
    STEP_TYPES.includes(v.type as StepType) ||
    v.type === "toFrame" ||
    (GRAPH_STEP_TYPES as readonly unknown[]).includes(v.type);
  if (typeof v.id !== "string" || !known) return null;
  return value as Step;
}

/**
 * The edited steps, followed by the stored entries this UI does not know (a newer server's
 * step type), so editing a panel never drops what it cannot show.
 */
export function withUnknown(stored: readonly unknown[], steps: readonly Step[]): unknown[] {
  return [...steps, ...stored.filter((v) => asStep(v) === null)];
}

export function asSteps(values: readonly unknown[]): Step[] {
  return values.map(asStep).filter((s): s is Step => s !== null);
}

export interface StepOutcome {
  /** The step's id, so a list edited since the run still finds its own results. */
  id: string;
  /** The frames after this step; absent when it failed or was not reached. */
  frames?: NamedFrame[];
  /** The graphs after this step, with the frames. */
  graphs?: NamedGraph[];
  /** Where a graph step ran on the server's side; absent: in the browser, as a preview. */
  ranIn?: RanIn;
  error?: Detail;
  /** Disabled, or after a failed step. */
  skipped: boolean;
}

export interface StepsRun {
  /** The frames after the last step that ran; the error, if any, is in `failed`. */
  frames: NamedFrame[];
  /** The graphs no step turned into a frame, as the last step that ran left them. */
  graphs: NamedGraph[];
  steps: StepOutcome[];
  failed?: { index: number; error: Detail };
}

/**
 * Runs the enabled steps in order; the first failure stops the run. A projection turns the
 * documents of its query into a frame at that query's place; documents are no frame for any
 * other step (as the server runs them). Graph steps read the graph of their query; one that makes
 * a frame puts it at that query's place. Steps the server ran (`server`) take its results.
 */
export function runSteps(
  steps: readonly Step[],
  inputs: readonly NamedInput[],
  /**
   * The calendar calculated fields read times in (UTC and Monday when absent), and smaller
   * limits for tests; the default limits are the server's.
   */
  options: { textBudget?: number; maxCells?: number; calendar?: Calendar; server?: ServerSteps } = {},
): StepsRun {
  const budget: Budget = {
    textLeft: options.textBudget ?? MAX_RUN_TEXT_UNITS,
    maxCells: options.maxCells ?? MAX_CELLS,
    calendar: options.calendar ?? UTC_CALENDAR,
  };
  const server = options.server;
  const order = inputs.map((i) => i.name);
  const documents = inputs.flatMap((i) => ("documents" in i ? [i] : []));
  let current: NamedFrame[] = inputs.flatMap((i) => ("frame" in i ? [i] : []));
  let graphs: NamedGraph[] = inputs.flatMap((i) => ("graph" in i ? [i] : []));
  // The last step the server ran per query: where its result for that query stands.
  const lastRan = new Map<string, string>();
  for (const step of steps) {
    if (step.disabled !== true && isGraphStep(step) && server?.ran.has(step.id) === true) {
      lastRan.set(step.frame, step.id);
    }
  }
  /** `name`'s result is `input` now, at that query's place. */
  const put = (name: string, input: NamedInput) => {
    current = current.filter((f) => f.name !== name);
    graphs = graphs.filter((g) => g.name !== name);
    if ("frame" in input) current = placed(current, { name, frame: input.frame }, order);
    else if ("graph" in input) graphs = [...graphs, { name, graph: input.graph }];
  };
  const outcomes: StepOutcome[] = [];
  let failed: StepsRun["failed"];
  steps.forEach((step, index) => {
    if (failed !== undefined || step.disabled === true) {
      outcomes.push({ id: step.id, skipped: true });
      return;
    }
    const ran = isGraphStep(step) ? server?.ran.get(step.id) : undefined;
    try {
      if (ran !== undefined) {
        const result = server?.results?.get(step.frame);
        if (result !== undefined && lastRan.get(step.frame) === step.id) {
          put(step.frame, result);
        } else if (result !== undefined && graphs.some((g) => g.name === step.frame)) {
          // A step before the last one the server ran: a preview of it on the graph here.
          ({ current, graphs } = graphStep(step, current, graphs, order, budget));
        }
        if (ran.error !== undefined) {
          throw new DetailError({
            reason: ran.error.reason ?? ran.error.code,
            params: ran.error.params ?? {},
            message: ran.error.message,
          });
        }
      } else if (isGraphStep(step)) {
        ({ current, graphs } = graphStep(step, current, graphs, order, budget));
      } else {
        current = isProjection(step)
          ? project(step, current, documents, order)
          : apply(step, current, budget);
      }
      outcomes.push({
        id: step.id,
        frames: current,
        graphs,
        skipped: false,
        ...(ran === undefined ? {} : { ranIn: ran.ranIn }),
      });
    } catch (e) {
      const error =
        e instanceof DetailError
          ? e.detail
          : { reason: "internal", params: {}, message: e instanceof Error ? e.message : String(e) };
      failed = { index, error };
      outcomes.push({
        id: step.id,
        error,
        skipped: false,
        ...(ran === undefined ? {} : { ranIn: ran.ranIn }),
      });
    }
  });
  return failed === undefined
    ? { frames: current, graphs, steps: outcomes }
    : { frames: current, graphs, steps: outcomes, failed };
}

/** `frames` with `added` in the place of its query, so the order stays the queries' order. */
function placed(frames: NamedFrame[], added: NamedFrame, order: readonly string[]): NamedFrame[] {
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  let place = 0;
  while (place < frames.length && rank((frames[place] as NamedFrame).name) < rank(added.name)) {
    place++;
  }
  const next = [...frames];
  next.splice(place, 0, added);
  return next;
}

function graphStep(
  step: Step,
  frames: NamedFrame[],
  graphs: NamedGraph[],
  order: readonly string[],
  budget: Budget,
): { current: NamedFrame[]; graphs: NamedGraph[] } {
  const name = stepFrames(step)[0] ?? "";
  const at = graphs.findIndex((g) => g.name === name);
  const input = graphs[at];
  if (input === undefined) {
    throw detail("steps.not_graph", `the result ${name} is no graph`, { frame: name });
  }
  const out = applyGraphStep(step as Parameters<typeof applyGraphStep>[0], input.graph, budget.maxCells);
  if ("graph" in out) {
    const next = [...graphs];
    next[at] = { name, graph: out.graph };
    return { current: frames, graphs: next };
  }
  return {
    current: placed(frames, { name, frame: out.frame }, order),
    graphs: graphs.filter((_, i) => i !== at),
  };
}

function project(
  step: ProjectionStep,
  frames: NamedFrame[],
  documents: { name: string; documents: DocumentSet }[],
  order: readonly string[],
): NamedFrame[] {
  const at = documents.findIndex((d) => d.name === step.frame);
  const set = documents[at];
  if (set === undefined) {
    // A result that already is a frame passes unchanged.
    if (frames.some((f) => f.name === step.frame)) return frames;
    throw detail("steps.frame_missing", `there is no result ${step.frame} to project`, {
      frame: step.frame,
    });
  }
  documents.splice(at, 1);
  return placed(frames, { name: set.name, frame: projectDocuments(set.documents, step.columns) }, order);
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

/** Numbers, int64 and decimal text: fields steps compute with. */
const isNumeric = (t: FieldType) => t === "number" || t === "int64" || t === "decimal";
/** Times and days: both are Unix ms on a time line. */
const isTime = (t: FieldType) => t === "time" || t === "date";

/**
 * A decimal's text in one form, so equal decimals group and join together: no leading zeros, no
 * trailing zeros after the point, no point without a fraction, no negative zero ("-012.50" is
 * "-12.5"). Text that is no plain decimal stays as it is. The server writes the same.
 */
export function canonicalDecimal(s: string): string {
  const t = s.trim();
  const negative = t.startsWith("-");
  const digits = negative || t.startsWith("+") ? t.slice(1) : t;
  const point = digits.indexOf(".");
  const whole = point < 0 ? digits : digits.slice(0, point);
  const fraction = point < 0 ? "" : digits.slice(point + 1);
  const plain = (p: string) => /^[0-9]*$/.test(p);
  if (!plain(whole) || !plain(fraction) || (whole === "" && fraction === "")) return s;
  const w = whole.replace(/^0+/, "") || "0";
  const f = fraction.replace(/0+$/, "");
  const body = f === "" ? w : `${w}.${f}`;
  return negative && body !== "0" ? `-${body}` : body;
}

function numericField(frame: Frame, name: string): Field {
  const f = fieldAt(frame, fieldIndex(frame, name));
  if (!isNumeric(f.type)) throw wrongType(f);
  return f;
}

function firstTimeField(nf: NamedFrame): number {
  const i = nf.frame.fields.findIndex((f) => isTime(f.type));
  if (i < 0) {
    throw detail("steps.no_time_field", `table ${nf.name} has no time field`, { frame: nf.name });
  }
  return i;
}

function timeField(nf: NamedFrame, name: string | undefined): number {
  if (name === undefined) return firstTimeField(nf);
  const i = fieldIndex(nf.frame, name);
  const f = fieldAt(nf.frame, i);
  if (!isTime(f.type)) throw wrongType(f);
  return i;
}

function checkFree(frame: Frame, name: string): void {
  if (frame.fields.some((f) => f.name === name)) {
    throw detail("steps.name_taken", `a field is already named ${name}`, { name });
  }
}

/**
 * A cell as a number: numbers, int64 text (by the shared number grammar, `parseNumber`) and
 * times; anything else is empty.
 */
export function numberAt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return parseNumber(value);
  return null;
}

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

/**
 * An int64 cell as an exact integer: an optional sign and digits, spaces around allowed, within
 * the range of i128 (as the server reads it).
 */
export function intOf(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value !== "string") return null;
  const t = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = BigInt(t);
  return n > I128_MAX || n < I128_MIN ? null : n;
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
    return intOf(value)?.toString() ?? value;
  }
  if (type === "decimal" && typeof value === "string") return canonicalDecimal(value);
  if (typeof value === "number") return numberText(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function keyable(field: Field): void {
  if (field.type === "json") throw wrongType(field);
}

// ---- steps ----

function apply(step: AnalysisStep, frames: NamedFrame[], budget: Budget): NamedFrame[] {
  if (step.type === "join") return join(frames, step, budget);
  const index = position(frames, step.frame);
  const nf = frames[index] as NamedFrame;
  const frame = nf.frame;
  let result: Frame;
  switch (step.type) {
    case "calculate": {
      checkFree(frame, step.name);
      const compiled = compile(parse(step.expression), frame.fields, budget.calendar);
      const type = compiled.result === "null" ? "number" : FIELD_TYPE_OF[compiled.result];
      checkCells(budget, rowsOf(frame), frame.fields.length + 1);
      const values = Array.from({ length: rowsOf(frame) }, (_, row) => {
        const cell = toCell(compiled.result, compiled.eval(row));
        spendText(budget, textUnits(cell));
        return cell;
      });
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
      result = group(frame, step.by, step.aggregations, budget);
      break;
    case "pivot":
      result = pivot(frame, step.row, step.column, step.value, step.op, budget);
      break;
    default:
      // Projections and graph steps run in runSteps; an existing frame passes a projection.
      result = frame;
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
    if (!isNumeric(f.type) && !isTime(f.type)) throw wrongType(f);
    xs = numbers(f);
    overTime = isTime(f.type);
  } else {
    const f = frame.fields.find((t) => isTime(t.type));
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
  if ((op === "min" || op === "max") && (isNumeric(t) || isTime(t) || t === "string")) {
    return t;
  }
  if ((op === "sum" || op === "mean" || op === "median" || op === "stddev") && isNumeric(t)) {
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
          const x = intOf(a);
          const y = intOf(b);
          if (x !== null && y !== null) return x < y;
          return (numberAt(a) as number) < (numberAt(b) as number);
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

function group(frame: Frame, by: string[], aggregations: Aggregation[], budget: Budget): Frame {
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
  checkCells(budget, rows.length, by.length + plan.length);
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

function pivot(
  frame: Frame,
  row: string,
  column: string,
  value: string,
  op: Agg,
  budget: Budget,
): Frame {
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
  checkCells(budget, rowGroups.length, colGroups.length + 1);
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
        : cf.type === "date" && ms !== null
          ? isoTime(Math.trunc(ms)).slice(0, 10)
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

/**
 * Whether two key fields can be compared: numbers, int64 and decimals with each other, times
 * with days (both Unix ms), or the same type.
 */
function sameFamily(a: FieldType, b: FieldType): boolean {
  return (isNumeric(a) && isNumeric(b)) || (isTime(a) && isTime(b)) || (a === b && a !== "json");
}

/**
 * A key cell of the right frame in the type of the left key field: numbers, int64 and decimals
 * mix (int64 and decimals as their decimal text); times and days are both Unix ms.
 */
function convertKey(value: unknown, from: FieldType, to: FieldType): unknown {
  if (from !== to && isNumeric(from) && isNumeric(to)) {
    return to === "number" ? numCell(numberAt(value)) : keyOf(value, from);
  }
  return value ?? null;
}

function join(
  frames: NamedFrame[],
  step: Extract<StepKind, { type: "join" }>,
  budget: Budget,
): NamedFrame[] {
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
  // The result has the key and every other field of both sides; checked as pairs grow, before
  // a single cell is copied.
  const width = l.frame.fields.length + r.frame.fields.length - 1;
  const fits = (n: number) => {
    if (n > MAX_ROWS) throw tooMany();
    checkCells(budget, n, width);
  };
  const pairs: [number | null, number | null][] = [];
  const matched = new Array<boolean>(rowsOf(r.frame)).fill(false);
  lkf.values.forEach((v, row) => {
    const k = keyOf(v, lkf.type);
    const hits = k === null ? undefined : byKey.get(k);
    if (hits !== undefined) {
      for (const j of hits) {
        matched[j] = true;
        pairs.push([row, j]);
        if (pairs.length % 4096 === 0) fits(pairs.length);
      }
    } else if (step.mode !== "inner") {
      pairs.push([row, null]);
    }
    fits(pairs.length);
  });
  if (step.mode === "outer") {
    matched.forEach((m, j) => {
      if (!m) pairs.push([null, j]);
    });
    fits(pairs.length);
  }
  {
    // The text the copies take, against the run's budget.
    const rowText = (f: Frame) =>
      Array.from({ length: rowsOf(f) }, (_, i) =>
        f.fields.reduce((sum, x) => sum + textUnits(x.values[i]), 0),
      );
    const lt = rowText(l.frame);
    const rt = rowText(r.frame);
    let copied = 0;
    for (const [i, j] of pairs)
      copied += (i === null ? 0 : (lt[i] ?? 0)) + (j === null ? 0 : (rt[j] ?? 0));
    spendText(budget, copied);
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
