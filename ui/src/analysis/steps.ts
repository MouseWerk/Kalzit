import type {
  DocumentSet,
  ErrorBody,
  Field,
  FieldType,
  Frame,
  FrameMeta,
  GraphSet,
  RanIn,
  TraceSet,
} from "../api/generated/shapes";
import {
  AGGS,
  type Agg,
  aggName,
  aggregate,
  intOf,
  numberAt,
  numCell,
  resultType,
} from "./calculations";
import {
  addMonths,
  type Calendar,
  compareText,
  compile,
  DAY_MS,
  type Detail,
  DetailError,
  daysFromCivil,
  daysInMonth,
  detail,
  FIELD_TYPE_OF,
  isoTime,
  MAX_TIME_MS,
  MIN_TIME_MS,
  numberText,
  parse,
  parseNumber,
  toCell,
  UTC_CALENDAR,
} from "./expr";
import { applyGraphStep, type GraphRows, type GraphStepKind } from "./graphSteps";
import { type ProjectionColumn, projectDocuments } from "./projection";
import * as stats from "./stats";
import { TRACE_STEP_TYPES, type TraceStepKind } from "./traceSteps";

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
export type { Agg };
export { AGGS, intOf, numberAt };
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

export type KeepDrop = "keep" | "drop";
export type MatchMode = "all" | "any";
export type RowOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "matches"
  | "empty"
  | "notEmpty";
export type LimitFrom = "first" | "last";
export type ConvertTo = "number" | "string" | "time" | "bool";
export type ReduceMode = "rows" | "columns";

export const ROW_OPS: readonly RowOp[] = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "contains",
  "matches",
  "empty",
  "notEmpty",
];
export const CONVERT_TO: readonly ConvertTo[] = ["number", "string", "time", "bool"];

/** A condition on the cells of one field (`filterRows`). */
export interface RowCondition {
  field: string;
  op: RowOp;
  value?: string | number | boolean;
  /** The upper end of `between`. */
  to?: string | number;
}

/** One field to convert; `format` reads text as a time (`DD.MM.YYYY HH:mm`). */
export interface Conversion {
  field: string;
  to: ConvertTo;
  format?: string;
}

export interface Aggregation {
  field: string;
  op: Agg;
  name?: string;
}

/** One key of a sort step: a field, ascending unless `desc`. */
export interface SortKey {
  field: string;
  desc?: boolean;
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
  /** The rows ordered by up to five fields; stable, empty cells last in either direction. */
  | { type: "sort"; frame: string; by: SortKey[] }
  /** Order, hide and rename fields; names no field has are passed over. */
  | {
      type: "organize";
      frame: string;
      order?: string[];
      hide?: string[];
      rename?: Record<string, string>;
    }
  | { type: "filterFields"; frame: string; mode: KeepDrop; names?: string[]; pattern?: string }
  | {
      type: "filterRows";
      frame: string;
      mode: KeepDrop;
      match: MatchMode;
      conditions: RowCondition[];
    }
  | { type: "limit"; frame: string; count: number; from?: LimitFrom }
  | { type: "convert"; frame: string; conversions: Conversion[] }
  /** Each series reduced: one row per series (`rows`) or one row of all (`columns`). */
  | {
      type: "reduceSeries";
      frame: string;
      mode: ReduceMode;
      calculations: Agg[];
      fields?: string[];
    }
  /** The rows of all `frames` one under the other, at the place of the first. */
  | { type: "stack"; frames: string[] }
  /** Number fields of `frames` as `time`, `metric`, `value`, at the place of the first. */
  | { type: "seriesToRows"; frames: string[] }
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
  | GraphStepKind
  /** Trace steps (traceSteps.ts): they read a trace; the server runs them with the query. */
  | TraceStepKind;

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
  "degree",
  "filterGraph",
] as const satisfies readonly StepType[];

/**
 * Whether the step reads a graph. Graph steps run with their query, in the database where the
 * source can, else on the server (docs/api/datasources.md, "Graph steps").
 */
export type GraphStepOf =
  | GraphStepKind
  | (Extract<StepKind, { type: "toFrame" }> & { rows: GraphRows });

export function isGraphStep(step: StepKind): step is GraphStepOf {
  return (
    (GRAPH_STEP_TYPES as readonly string[]).includes(step.type) ||
    (step.type === "toFrame" && step.rows !== undefined)
  );
}

export type TraceStepOf = Extract<StepKind, TraceStepKind>;

/** Whether the step reads a trace (docs/guide/traces.md). */
export function isTraceStep(step: StepKind): step is TraceStepOf {
  return (TRACE_STEP_TYPES as readonly string[]).includes(step.type);
}

/** Whether the step runs with its query on the server's side: a graph step or a trace step. */
export function runsWithQuery(step: StepKind): step is GraphStepOf | TraceStepOf {
  return isGraphStep(step) || isTraceStep(step);
}

export const STEP_TYPES: readonly StepType[] = [
  "calculate",
  "organize",
  "filterFields",
  "convert",
  "filterRows",
  "limit",
  "join",
  "stack",
  "seriesToRows",
  "reduceSeries",
  "reduce",
  "trend",
  "movingAverage",
  "correlate",
  "compare",
  "group",
  "pivot",
  "sort",
];

/** The server's bounds (server/src/analysis/mod.rs). */
export const MAX_STEPS = 50;
/** Fields one sort step orders by. */
export const MAX_SORT_KEYS = 5;
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

export interface NamedTrace {
  name: string;
  trace: TraceSet;
}

/**
 * A query's result as the steps read it: a frame, documents a projection may turn into one, or a
 * graph the graph steps read, or a trace the trace steps read.
 */
export type NamedInput =
  | NamedFrame
  | { name: string; documents: DocumentSet }
  | NamedGraph
  | NamedTrace;

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
  if (step.type === "join") return [step.left, step.right];
  if (step.type === "stack" || step.type === "seriesToRows") return step.frames;
  return [step.frame];
}

/** A stored step, or null for anything that is not one; the server checked what it stored. */
export function asStep(value: unknown): Step | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const known =
    STEP_TYPES.includes(v.type as StepType) ||
    v.type === "toFrame" ||
    (GRAPH_STEP_TYPES as readonly unknown[]).includes(v.type) ||
    (TRACE_STEP_TYPES as readonly unknown[]).includes(v.type);
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
  /** The traces after this step. */
  traces?: NamedTrace[];
  /** A trace step the server has not answered yet: its result is not known here. */
  waiting?: boolean;
  /** Where a graph step ran on the server's side; absent: in the browser, as a preview. */
  ranIn?: RanIn;
  error?: Detail;
  /** Disabled, or after a failed step. */
  skipped: boolean;
}

export interface NamedDocuments {
  name: string;
  documents: DocumentSet;
}

export interface StepsRun {
  /** The frames after the last step that ran; the error, if any, is in `failed`. */
  frames: NamedFrame[];
  /** The graphs no step turned into a frame, as the last step that ran left them. */
  graphs: NamedGraph[];
  /** The documents no projection turned into a frame (an export writes them as they are). */
  documents: NamedDocuments[];
  /** The traces no trace step turned into a table or a graph. */
  traces: NamedTrace[];
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
  options: {
    textBudget?: number;
    maxCells?: number;
    calendar?: Calendar;
    server?: ServerSteps;
  } = {},
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
  let traces: NamedTrace[] = inputs.flatMap((i) => ("trace" in i ? [i] : []));
  // The last step the server ran per query: where its result for that query stands.
  const lastRan = new Map<string, string>();
  for (const step of steps) {
    if (step.disabled !== true && runsWithQuery(step) && server?.ran.has(step.id) === true) {
      lastRan.set(step.frame, step.id);
    }
  }
  /** `name`'s result is `input` now, at that query's place. */
  const put = (name: string, input: NamedInput) => {
    current = current.filter((f) => f.name !== name);
    graphs = graphs.filter((g) => g.name !== name);
    traces = traces.filter((x) => x.name !== name);
    if ("frame" in input) current = placed(current, { name, frame: input.frame }, order);
    else if ("graph" in input) graphs = [...graphs, { name, graph: input.graph }];
    else if ("trace" in input) traces = [...traces, { name, trace: input.trace }];
  };
  const outcomes: StepOutcome[] = [];
  let failed: StepsRun["failed"];
  steps.forEach((step, index) => {
    if (failed !== undefined || step.disabled === true) {
      outcomes.push({ id: step.id, skipped: true });
      return;
    }
    const ran = runsWithQuery(step) ? server?.ran.get(step.id) : undefined;
    const target = stepFrames(step)[0] ?? "";
    try {
      if (ran !== undefined) {
        const result = server?.results?.get(target);
        if (result !== undefined && lastRan.get(target) === step.id) {
          put(target, result);
        } else if (
          result !== undefined &&
          isGraphStep(step) &&
          graphs.some((g) => g.name === target)
        ) {
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
      } else if (isTraceStep(step)) {
        // Only the server runs trace steps. Until it answered, the step shows nothing of its
        // own; a result that is no trace cannot be read by it at all.
        if (!traces.some((x) => x.name === target)) {
          throw detail("steps.not_trace", `the result ${target} is no trace`, { frame: target });
        }
        outcomes.push({ id: step.id, skipped: false, waiting: true });
        return;
      } else {
        current = isProjection(step)
          ? project(step, current, documents, order)
          : apply(step, current, budget);
      }
      outcomes.push({
        id: step.id,
        frames: current,
        graphs,
        traces,
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
    ? { frames: current, graphs, documents, traces, steps: outcomes }
    : { frames: current, graphs, documents, traces, steps: outcomes, failed };
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
  const out = applyGraphStep(
    step as Parameters<typeof applyGraphStep>[0],
    input.graph,
    budget.maxCells,
  );
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
  return placed(
    frames,
    { name: set.name, frame: projectDocuments(set.documents, step.columns) },
    order,
  );
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

const numbers = (field: Field) => field.values.map(numberAt);

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
  if (step.type === "stack") return stack(frames, step.frames, budget);
  if (step.type === "seriesToRows") return seriesToRows(frames, step.frames, budget);
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
    case "sort":
      result = sort(frame, step.by, budget);
      break;
    case "organize":
      result = organize(frame, step.order ?? [], step.hide ?? [], step.rename ?? {});
      break;
    case "filterFields":
      result = filterFields(frame, step.mode, step.names ?? [], step.pattern);
      break;
    case "filterRows":
      result = filterRows(frame, step.mode, step.match, step.conditions);
      break;
    case "limit":
      result = limitRows(frame, step.count, step.from ?? "first");
      break;
    case "convert":
      result = convert(frame, step.conversions, budget);
      break;
    case "reduceSeries":
      result = reduceSeries(frame, step.mode, step.calculations, step.fields ?? [], budget);
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
  const t = resultType(op, field.type);
  if (t === null) throw wrongType(field);
  return t;
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
    const name = a.name ?? `${aggName(a.op)}(${a.field})`;
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

type SortValue = bigint | number | string | boolean;

/**
 * A cell's place in a sort, by its field's type: int64 as an exact integer, the other numbers,
 * times and days as numbers, text by code point, false before true. Empty cells and cells that
 * are no value of their field's type have none and come last (as the server sorts).
 */
function sortValue(value: unknown, type: FieldType): SortValue | null {
  switch (type) {
    case "int64":
      return intOf(value);
    case "number":
    case "decimal":
    case "time":
    case "date":
      return numberAt(value);
    case "string":
      return typeof value === "string" ? value : null;
    case "bool":
      return typeof value === "boolean" ? value : null;
    default:
      return null;
  }
}

function compareSort(a: SortValue, b: SortValue): number {
  if (typeof a === "string" && typeof b === "string") return compareText(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sort(frame: Frame, by: readonly SortKey[], budget: Budget): Frame {
  const keys = by.map((k) => ({ field: fieldAt(frame, fieldIndex(frame, k.field)), desc: k.desc }));
  for (const k of keys) keyable(k.field);
  const rows = rowsOf(frame);
  checkCells(budget, rows, frame.fields.length);
  const columns = keys.map((k) => k.field.values.map((v) => sortValue(v, k.field.type)));
  const order = Array.from({ length: rows }, (_, i) => i);
  // Array.prototype.sort is stable, so rows with equal keys keep their order.
  order.sort((a, b) => {
    for (let i = 0; i < keys.length; i++) {
      const column = columns[i] as (SortValue | null)[];
      const x = column[a] ?? null;
      const y = column[b] ?? null;
      const o =
        x !== null && y !== null
          ? compareSort(x, y) * (keys[i]?.desc === true ? -1 : 1)
          : x !== null
            ? -1
            : y !== null
              ? 1
              : 0;
      if (o !== 0) return o;
    }
    return 0;
  });
  return frameOf(
    frame.fields.map((f) => ({ ...f, values: order.map((r) => f.values[r] ?? null) })),
    frame.meta,
  );
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

// ---- table steps: organize, filter, limit, convert, reduce, stack, series to rows ----
// The server runs the same in `server/src/analysis/table.rs`.

/** Rows a step that puts tables together may make. */
export const MAX_RESULT_ROWS = 500_000;

/** A field with the same name, type, unit and labels and other values. */
function copyWith(f: Field, values: unknown[]): Field {
  return copyField(f, values);
}

/** The rows `rows` of every field of `frame`, in that order. */
function takeRows(frame: Frame, rows: readonly number[]): Frame {
  return frameOf(
    frame.fields.map((f) =>
      copyWith(
        f,
        rows.map((r) => f.values[r] ?? null),
      ),
    ),
    frame.meta,
  );
}

/** Characters a pattern may escape with a backslash (inside a class `-` too). */
const ESCAPABLE = "^$\\.*+?()[]{}|/";
/** The largest count a `{n,m}` may name. */
const MAX_REPEAT = 1000;
/**
 * Characters of a cell or field name that `matches` and **filterFields** read; the rest is passed
 * over, so that a pattern takes bounded time in the browser.
 */
export const MAX_MATCH_CHARS = 150;
/** Characters a pattern may have. */
const MAX_PATTERN_CHARS = 2000;
/**
 * Repetitions (`*`, `+`, `?`, `{n,}`, `{n,m}` with m > 1) a pattern may hold besides a leading or
 * trailing `.*`; each one multiplies the work of backtracking by the length of the text.
 */
const MAX_QUANTIFIERS = 2;
/**
 * Ways through the alternatives of groups a pattern without repetitions may have, and what each
 * repetition divides that by.
 */
const MAX_PATHS = 4096;
const QUANTIFIER_PATHS = 64;
/**
 * Size a pattern may expand to (a character its UTF-8 bytes, a class or `.` 40, repeated by its
 * count), which keeps the expression the server compiles under half of its size limit.
 */
const MAX_WEIGHT = 16_000;
const CLASS_WEIGHT = 40;
/** What `.` stands for: any character but a line end (the server compiles the same). */
const DOT = "[^\\r\\n\\u2028\\u2029]";

/** Backslashes right at the end of `text`. */
function trailingBackslashes(text: string): number {
  let n = 0;
  while (n < text.length && text[text.length - 1 - n] === "\\") n += 1;
  return n;
}

/**
 * `pattern` without a leading or trailing `.*` (or `.*?`), which change nothing for a pattern
 * found anywhere in the text.
 */
function trimWildcards(pattern: string): string {
  let p = pattern;
  for (;;) {
    if (p.startsWith(".*?")) p = p.slice(3);
    else if (p.startsWith(".*")) p = p.slice(2);
    else break;
  }
  for (;;) {
    const cut = p.endsWith(".*?") ? 3 : p.endsWith(".*") ? 2 : 0;
    if (cut === 0) break;
    const rest = p.slice(0, p.length - cut);
    // A `.` after an odd number of backslashes is escaped.
    if (trailingBackslashes(rest) % 2 === 1) break;
    p = rest;
  }
  return p;
}

/** UTF-8 bytes of the code point `ch`. */
function utf8Bytes(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

interface OpenGroup {
  /** Whether its body holds a quantifier. */
  quantified: boolean;
  /** Whether a group inside it holds a `|`. */
  alternation: boolean;
  /** Its alternatives (`|` plus one). */
  branches: number;
  weight: number;
}

/** What a quantifier would apply to. */
interface Item {
  weight: number;
  quantified: boolean;
  alternation: boolean;
}

/**
 * Whether `pattern` keeps to the subset of regular expressions both engines read the same and run
 * in bounded time (server/src/analysis/table.rs, `safe_pattern`): literals, `.`, `^`, `$`, `|`,
 * `(...)`, classes with ranges, `*`, `+`, `?`, `{n,m}` (optionally lazy) and escapes of the special
 * characters. No `(?`, no letter escapes, no class set operations, no quantified group that holds a
 * quantifier (`(a+)+`) or a `|` (`(a|aa)+`); besides a leading or trailing `.*` at most
 * `MAX_QUANTIFIERS` repetitions, fewer alternatives the more repetitions there are, and at most
 * `MAX_PATTERN_CHARS` characters.
 */
export function safePattern(pattern: string): boolean {
  return Array.from(pattern).length <= MAX_PATTERN_CHARS && safeBody(trimWildcards(pattern));
}

function safeBody(pattern: string): boolean {
  const c = Array.from(pattern);
  const open = (): OpenGroup => ({ quantified: false, alternation: false, branches: 1, weight: 0 });
  const groups: OpenGroup[] = [open()];
  let last: Item | null = null;
  let quantifiers = 0;
  let paths = 1;
  const atom = (top: OpenGroup, weight: number): Item => {
    top.weight += weight;
    return { weight, quantified: false, alternation: false };
  };
  let i = 0;
  while (i < c.length) {
    const top = groups[groups.length - 1] as OpenGroup;
    const ch = c[i] as string;
    if (ch === "\\") {
      const n = c[i + 1];
      if (n === undefined || !ESCAPABLE.includes(n)) return false;
      last = atom(top, 1);
      i += 2;
      continue;
    }
    if (ch === "(") {
      if (c[i + 1] === "?") return false;
      groups.push(open());
      last = null;
    } else if (ch === ")") {
      if (groups.length === 1) return false;
      const inner = groups.pop() as OpenGroup;
      if (inner.branches > 1) paths *= inner.branches;
      const item: Item = {
        weight: inner.weight,
        quantified: inner.quantified,
        alternation: inner.alternation || inner.branches > 1,
      };
      const outer = groups[groups.length - 1] as OpenGroup;
      outer.weight += item.weight;
      outer.quantified ||= item.quantified;
      outer.alternation ||= item.alternation;
      last = item;
    } else if (ch === "|") {
      top.branches += 1;
      last = null;
    } else if (ch === "^" || ch === "$") {
      last = null;
    } else if (ch === "}" || ch === "]") {
      return false;
    } else if (ch === "[") {
      i += 1;
      if (c[i] === "^") i += 1;
      if (c[i] === "]") return false;
      for (;;) {
        const x = c[i];
        if (x === undefined || x === "[") return false;
        if (x === "]") break;
        if (x === "\\") {
          const n = c[i + 1];
          if (n === undefined || (n !== "-" && !ESCAPABLE.includes(n))) return false;
          i += 2;
        } else if ((x === "&" || x === "-" || x === "~") && c[i + 1] === x) {
          return false;
        } else {
          i += 1;
        }
      }
      last = atom(top, CLASS_WEIGHT);
    } else if (ch === ".") {
      last = atom(top, CLASS_WEIGHT);
    } else if (ch === "*" || ch === "+" || ch === "?" || ch === "{") {
      // Whether it counts as a repetition, and how many copies of its item it makes.
      let counted = true;
      let copies = 1;
      if (ch === "{") {
        const end = c.indexOf("}", i);
        if (end < 0) return false;
        const body = c.slice(i + 1, end).join("");
        const comma = body.indexOf(",");
        const [nText, mText] =
          comma < 0 ? [body, body] : [body.slice(0, comma), body.slice(comma + 1)];
        const number = (t: string) => (/^[0-9]{1,4}$/.test(t) ? Number(t) : null);
        const n = number(nText);
        if (n === null) return false;
        const m = mText === "" ? n : number(mText);
        if (m === null || m < n || m > MAX_REPEAT) return false;
        i = end;
        if (body.endsWith(",")) {
          copies = n + 1;
        } else {
          counted = m > 1;
          copies = Math.max(m, 1);
        }
      }
      if (last === null || last.quantified || last.alternation) return false;
      top.weight += last.weight * (copies - 1);
      top.quantified = true;
      if (counted) quantifiers += 1;
      last = null;
      if (c[i + 1] === "?") i += 1;
    } else {
      last = atom(top, utf8Bytes(ch));
    }
    i += 1;
  }
  return (
    groups.length === 1 &&
    quantifiers <= MAX_QUANTIFIERS &&
    paths * QUANTIFIER_PATHS ** quantifiers <= MAX_PATHS &&
    (groups[0] as OpenGroup).weight <= MAX_WEIGHT
  );
}

/**
 * The text the engine compiles for a pattern `safePattern` took: without a leading or trailing
 * `.*`, and `.` as `DOT`.
 */
function engineSource(pattern: string): string {
  const c = Array.from(trimWildcards(pattern));
  let out = "";
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i] as string;
    if (ch === "\\") {
      out += ch + (c[i + 1] ?? "");
      i += 1;
    } else if (ch === "[") {
      out += ch;
      for (i += 1; i < c.length; i += 1) {
        const x = c[i] as string;
        out += x;
        if (x === "\\") {
          out += c[i + 1] ?? "";
          i += 1;
        } else if (x === "]") {
          break;
        }
      }
    } else {
      out += ch === "." ? DOT : ch;
    }
  }
  return out;
}

/** The first `MAX_MATCH_CHARS` characters (code points) of `text`, which a pattern reads. */
export function matchHead(text: string): string {
  if (text.length <= MAX_MATCH_CHARS) return text;
  let at = 0;
  for (let n = 0; n < MAX_MATCH_CHARS && at < text.length; n += 1) {
    at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  }
  return text.slice(0, at);
}

/**
 * A regular expression over field names or cell text, found anywhere in their first
 * `MAX_MATCH_CHARS` characters, in the subset `safePattern` allows.
 */
export function fieldPattern(pattern: string): RegExp {
  const refused = () =>
    detail("steps.pattern", `${pattern} is no regular expression this step can read`, {
      pattern,
    });
  if (!safePattern(pattern)) throw refused();
  try {
    return new RegExp(engineSource(pattern), "u");
  } catch {
    throw refused();
  }
}

function organize(
  frame: Frame,
  order: readonly string[],
  hide: readonly string[],
  rename: Readonly<Record<string, string>>,
): Frame {
  const fields = frame.fields;
  const placedAt = new Array<boolean>(fields.length).fill(false);
  const picked: number[] = [];
  for (const name of order) {
    fields.forEach((f, i) => {
      if (!placedAt[i] && f.name === name) {
        placedAt[i] = true;
        picked.push(i);
      }
    });
  }
  fields.forEach((_, i) => {
    if (!placedAt[i]) picked.push(i);
  });
  const hidden = new Set(hide);
  const renames = new Map(Object.entries(rename));
  const out = picked
    .filter((i) => !hidden.has((fields[i] as Field).name))
    .map((i) => {
      const f = fields[i] as Field;
      const field = copyWith(f, f.values);
      const to = renames.get(f.name);
      const renamed = to !== undefined && to !== f.name;
      if (renamed) field.name = to;
      return { field, renamed };
    });
  // A new name may not be one another field keeps; fields that already shared a name may.
  out.forEach(({ field, renamed }, i) => {
    if (renamed && out.some((o, j) => j !== i && o.field.name === field.name)) {
      throw detail("steps.name_taken", `a field is already named ${field.name}`, {
        name: field.name,
      });
    }
  });
  return frameOf(
    out.map((o) => o.field),
    frame.meta,
  );
}

function filterFields(
  frame: Frame,
  mode: KeepDrop,
  names: readonly string[],
  pattern: string | undefined,
): Frame {
  const regex = pattern === undefined ? null : fieldPattern(pattern);
  const fields = frame.fields.filter((f) => {
    const hit = names.includes(f.name) || regex?.test(matchHead(f.name)) === true;
    return hit === (mode === "keep");
  });
  return frameOf(fields, frame.meta);
}

/** A cell as text for `contains` and `matches`: times and days in ISO 8601, the rest as groups compare them. */
function cellText(v: unknown, t: FieldType): string | null {
  if (t === "time" || t === "date") {
    const ms = numberAt(v);
    if (ms === null) return null;
    const iso = isoTime(Math.floor(ms));
    return t === "date" ? iso.slice(0, 10) : iso;
  }
  return keyOf(v, t);
}

const isEmptyCell = (v: unknown) => v === null || v === undefined || v === "";

type Test =
  | { kind: "empty" }
  | { kind: "notEmpty" }
  | { kind: "number"; op: RowOp; a: number; b: number }
  /** An int64 field against whole numbers: compared exactly. */
  | { kind: "int"; op: RowOp; a: bigint; b: bigint }
  | { kind: "text"; op: RowOp; a: string; b: string }
  | { kind: "bool"; op: RowOp; a: boolean }
  | { kind: "contains"; text: string }
  | { kind: "matches"; regex: RegExp };

function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return numberText(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

function badValue(field: Field, v: unknown) {
  const text = valueText(v);
  return detail("steps.filter_value", `${text} cannot be compared with field ${field.name}`, {
    field: field.name,
    value: text,
  });
}

/** A condition's value as a number for a field of numbers or times. */
function numberValue(field: Field, v: unknown): number {
  let n: number | null = null;
  if (typeof v === "number") n = Number.isFinite(v) ? v : null;
  else if (typeof v === "string") {
    n = parseNumber(v);
    if (n === null && isTime(field.type)) n = parseTime(v, undefined);
  }
  if (n === null) throw badValue(field, v);
  return n;
}

function prepare(field: Field, c: RowCondition): Test {
  const t = field.type;
  const value = c.value ?? null;
  if (c.op === "empty") return { kind: "empty" };
  if (c.op === "notEmpty") return { kind: "notEmpty" };
  if (t === "json") throw wrongType(field);
  if (c.op === "contains") return { kind: "contains", text: valueText(value) };
  if (c.op === "matches") return { kind: "matches", regex: fieldPattern(valueText(value)) };
  const whole = intOf(value);
  const upper = intOf(c.to ?? null);
  if (t === "int64" && whole !== null && (c.op !== "between" || upper !== null)) {
    return { kind: "int", op: c.op, a: whole, b: upper ?? 0n };
  }
  if (isNumeric(t) || isTime(t)) {
    const b = c.op === "between" ? numberValue(field, c.to ?? null) : 0;
    return { kind: "number", op: c.op, a: numberValue(field, value), b };
  }
  if (t === "string") {
    return { kind: "text", op: c.op, a: valueText(value), b: valueText(c.to ?? null) };
  }
  if (c.op === "eq" || c.op === "ne") {
    if (typeof value === "boolean") return { kind: "bool", op: c.op, a: value };
    if (value === "true" || value === "false")
      return { kind: "bool", op: c.op, a: value === "true" };
    throw badValue(field, value);
  }
  throw wrongType(field);
}

const order = (x: number | string | boolean, y: number | string | boolean): number =>
  typeof x === "string" && typeof y === "string" ? compareText(x, y) : x < y ? -1 : x > y ? 1 : 0;

function compareOp(op: RowOp, ord: number | null, upper: number | null): boolean {
  if (ord === null) return op === "ne";
  switch (op) {
    case "eq":
      return ord === 0;
    case "ne":
      return ord !== 0;
    case "gt":
      return ord > 0;
    case "gte":
      return ord >= 0;
    case "lt":
      return ord < 0;
    case "lte":
      return ord <= 0;
    case "between":
      return ord >= 0 && upper !== null && upper <= 0;
    default:
      return false;
  }
}

function passes(test: Test, v: unknown, t: FieldType): boolean {
  switch (test.kind) {
    case "empty":
      return isEmptyCell(v);
    case "notEmpty":
      return !isEmptyCell(v);
    case "contains": {
      const c = cellText(v, t);
      return c?.includes(test.text) === true;
    }
    case "matches": {
      const c = cellText(v, t);
      return c !== null && test.regex.test(matchHead(c));
    }
    case "number": {
      const x = numberAt(v);
      return compareOp(
        test.op,
        x === null ? null : order(x, test.a),
        x === null ? null : order(x, test.b),
      );
    }
    case "int": {
      const x = intOf(v);
      return compareOp(
        test.op,
        x === null ? null : x < test.a ? -1 : x > test.a ? 1 : 0,
        x === null ? null : x < test.b ? -1 : x > test.b ? 1 : 0,
      );
    }
    case "text": {
      const x = typeof v === "string" ? v : null;
      return compareOp(
        test.op,
        x === null ? null : order(x, test.a),
        x === null ? null : order(x, test.b),
      );
    }
    case "bool":
      return compareOp(test.op, typeof v === "boolean" ? order(v, test.a) : null, null);
  }
}

function filterRows(
  frame: Frame,
  mode: KeepDrop,
  match: MatchMode,
  conditions: readonly RowCondition[],
): Frame {
  const tests = conditions.map((c) => {
    const f = fieldAt(frame, fieldIndex(frame, c.field));
    return { f, test: prepare(f, c) };
  });
  const rows: number[] = [];
  for (let row = 0; row < rowsOf(frame); row++) {
    const hit = ({ f, test }: (typeof tests)[number]) =>
      passes(test, f.values[row] ?? null, f.type);
    const matched = match === "all" ? tests.every(hit) : tests.some(hit);
    if (matched === (mode === "keep")) rows.push(row);
  }
  return takeRows(frame, rows);
}

function limitRows(frame: Frame, count: number, from: LimitFrom): Frame {
  const n = rowsOf(frame);
  const keep = Math.min(count, n);
  const rows = Array.from({ length: keep }, (_, i) => (from === "last" ? n - keep + i : i));
  return takeRows(frame, rows);
}

/** `n` digits at `at`, as a number. */
function digitsAt(s: string, at: number, n: number): number | null {
  const part = s.slice(at, at + n);
  return part.length === n && /^[0-9]+$/.test(part) ? Number(part) : null;
}

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  offsetMin: number;
}

function isoParts(s: string, p: TimeParts): boolean {
  const y = digitsAt(s, 0, 4);
  const m = digitsAt(s, 5, 2);
  const d = digitsAt(s, 8, 2);
  if (y === null || m === null || d === null || s[4] !== "-" || s[7] !== "-") return false;
  p.year = y;
  p.month = m;
  p.day = d;
  if (s.length === 10) return true;
  if (s[10] !== "T" && s[10] !== "t" && s[10] !== " ") return false;
  const h = digitsAt(s, 11, 2);
  const mi = digitsAt(s, 14, 2);
  if (h === null || mi === null || s[13] !== ":") return false;
  p.hour = h;
  p.minute = mi;
  let at = 16;
  if (s[at] === ":") {
    const sec = digitsAt(s, at + 1, 2);
    if (sec === null) return false;
    p.second = sec;
    at += 3;
    if (s[at] === ".") {
      const start = at + 1;
      let end = start;
      while (end < s.length && /[0-9]/.test(s[end] as string) && end - start < 9) end++;
      if (end === start) return false;
      p.ms = Number(s.slice(start, Math.min(end, start + 3)).padEnd(3, "0"));
      at = end;
    }
  }
  const zone = s[at];
  if (zone === undefined) return true;
  if (zone === "Z" || zone === "z") return at + 1 === s.length;
  if (zone !== "+" && zone !== "-") return false;
  const oh = digitsAt(s, at + 1, 2);
  if (oh === null) return false;
  const rest = s.slice(at + 3);
  let om = 0;
  if (rest.length > 0) {
    const mm = /^:?([0-9]{2})$/.exec(rest);
    if (mm === null) return false;
    om = Number(mm[1]);
  }
  if (oh > 23 || om > 59) return false;
  p.offsetMin = (oh * 60 + om) * (zone === "-" ? -1 : 1);
  return true;
}

/** Characters of the longest text read as a time. */
const MAX_TIME_CHARS = 64;

const TIME_TOKENS = ["YYYY", "SSS", "MM", "DD", "HH", "mm", "ss"] as const;

function formatParts(s: string, f: string, p: TimeParts): boolean {
  let i = 0;
  let at = 0;
  while (i < f.length) {
    const token = TIME_TOKENS.find((t) => f.startsWith(t, i));
    if (token !== undefined) {
      const n = digitsAt(s, at, token.length);
      if (n === null) return false;
      if (token === "YYYY") p.year = n;
      else if (token === "SSS") p.ms = n;
      else if (token === "MM") p.month = n;
      else if (token === "DD") p.day = n;
      else if (token === "HH") p.hour = n;
      else if (token === "mm") p.minute = n;
      else p.second = n;
      i += token.length;
      at += token.length;
    } else {
      const c = f.codePointAt(i) as number;
      if (s.codePointAt(at) !== c) return false;
      const width = c > 0xffff ? 2 : 1;
      i += width;
      at += width;
    }
  }
  return at === s.length;
}

/**
 * Text read as a time, in ms (UTC unless the text names an offset): ISO 8601 without `format`
 * (`2026-01-31`, `2026-01-31T08:15`, `2026-01-31 08:15:00.250+01:00`), else by `format` with the
 * parts `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`, `SSS` (each with exactly that many digits) and any
 * other character as itself. Null when the text does not fit or names no real time.
 */
export function parseTime(text: string, format: string | undefined): number | null {
  const s = text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  // No time is written in more characters; longer text is not read at all.
  if (Array.from(s).length > MAX_TIME_CHARS) return null;
  const p: TimeParts = {
    year: 1970,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
    ms: 0,
    offsetMin: 0,
  };
  const ok = format === undefined ? isoParts(s, p) : formatParts(s, format, p);
  if (
    !ok ||
    p.month < 1 ||
    p.month > 12 ||
    p.day < 1 ||
    p.day > daysInMonth(p.year, p.month) ||
    p.hour > 23 ||
    p.minute > 59 ||
    p.second > 59
  ) {
    return null;
  }
  const ms =
    daysFromCivil(p.year, p.month, p.day) * DAY_MS +
    p.hour * 3_600_000 +
    p.minute * 60_000 +
    p.second * 1000 +
    p.ms -
    p.offsetMin * 60_000;
  return ms >= MIN_TIME_MS && ms <= MAX_TIME_MS ? ms : null;
}

/** A number as a time cell: whole ms within the years 1 to 9999, else empty. */
function timeCell(x: number | null): number | null {
  if (x === null || !Number.isFinite(x)) return null;
  const f = Math.floor(x);
  return f >= MIN_TIME_MS && f <= MAX_TIME_MS ? (f === 0 ? 0 : f) : null;
}

/** Text read as true or false: `true`, `false`, `1`, `0` in any case, spaces around allowed. */
export function boolOfText(s: string): boolean | null {
  const t = s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  return t === "true" || t === "1" ? true : t === "false" || t === "0" ? false : null;
}

function converted(f: Field, c: Conversion, budget: Budget): Field {
  const from = f.type;
  const refuse =
    (from === "json" && c.to !== "bool") ||
    (c.to === "time" && from === "bool") ||
    (c.to === "bool" && (from === "time" || from === "date" || from === "json"));
  if (refuse) throw wrongType(f);
  const same =
    (c.to === "number" && from === "number") ||
    (c.to === "string" && from === "string") ||
    (c.to === "time" && from === "time") ||
    (c.to === "bool" && from === "bool");
  if (same) return copyField(f, f.values);
  let type: FieldType;
  let values: unknown[];
  switch (c.to) {
    case "number":
      type = "number";
      values = f.values.map((v) =>
        from === "bool" ? (typeof v === "boolean" ? (v ? 1 : 0) : null) : numCell(numberAt(v)),
      );
      break;
    case "string":
      type = "string";
      values = f.values.map((v) => {
        let text: string | null;
        if (from === "number") {
          const x = numberAt(v);
          text = x === null ? null : numberText(x);
        } else if (from === "bool") text = typeof v === "boolean" ? (v ? "true" : "false") : null;
        else text = cellText(v, from);
        spendText(budget, textUnits(text));
        return text;
      });
      break;
    case "time":
      type = "time";
      values = f.values.map((v) =>
        from === "string"
          ? typeof v === "string"
            ? parseTime(v, c.format)
            : null
          : timeCell(numberAt(v)),
      );
      break;
    default:
      type = "bool";
      values = f.values.map((v) => {
        if (from === "string") return typeof v === "string" ? boolOfText(v) : null;
        const x = numberAt(v);
        return x === null ? null : x !== 0;
      });
      break;
  }
  const out: Field = { name: f.name, type, values };
  if (type === "number" && f.unit !== undefined) out.unit = f.unit;
  if (f.labels !== undefined) out.labels = f.labels;
  return out;
}

function convert(frame: Frame, conversions: readonly Conversion[], budget: Budget): Frame {
  const fields = [...frame.fields];
  for (const c of conversions) {
    const i = fieldIndex(frame, c.field);
    fields[i] = converted(fieldAt(frame, i), c, budget);
  }
  return frameOf(fields, frame.meta);
}

/** The unit all `fields` share, if they share one. */
function sharedUnit(fields: readonly Field[]): string | undefined {
  const first = fields[0]?.unit;
  if (first === undefined) return undefined;
  return fields.every((f) => f.unit === first) ? first : undefined;
}

function reduceSeries(
  frame: Frame,
  mode: ReduceMode,
  ops: readonly Agg[],
  names: readonly string[],
  budget: Budget,
): Frame {
  const fields =
    names.length === 0
      ? frame.fields.filter((f) => isNumeric(f.type))
      : names.map((n) => fieldAt(frame, fieldIndex(frame, n)));
  const all = Array.from({ length: rowsOf(frame) }, (_, i) => i);
  if (mode === "rows") {
    for (const f of fields) if (!isNumeric(f.type)) throw wrongType(f);
    checkCells(budget, fields.length, ops.length + 1);
    const unit = sharedUnit(fields);
    const out: Field[] = [
      newField(
        "field",
        "string",
        fields.map((f) => f.name),
      ),
    ];
    for (const op of ops) {
      const field = newField(
        aggName(op),
        "number",
        fields.map((f) => numCell(numberAt(aggregate(f, op, all)))),
      );
      if (op !== "count" && unit !== undefined) field.unit = unit;
      out.push(field);
    }
    return frameOf(out, frame.meta);
  }
  checkCells(budget, 1, fields.length * ops.length);
  const out: Field[] = [];
  for (const f of fields) {
    for (const op of ops) {
      const t = aggType(f, op);
      const field = newField(ops.length === 1 ? f.name : `${aggName(op)}(${f.name})`, t, [
        aggregate(f, op, all),
      ]);
      if (op !== "count" && f.unit !== undefined) field.unit = f.unit;
      if (f.labels !== undefined) field.labels = f.labels;
      out.push(field);
    }
  }
  return frameOf(out, frame.meta);
}

/** The metas of several frames as one: truncated when one is, all notices in order. */
function joinedMeta(metas: readonly (FrameMeta | undefined)[]): FrameMeta | undefined {
  let out: FrameMeta | undefined;
  for (const m of metas) {
    if (m === undefined) continue;
    out ??= { rowsTruncated: false, notices: [] };
    out.rowsTruncated = out.rowsTruncated || (m.rowsTruncated ?? false);
    out.notices = [...(out.notices ?? []), ...(m.notices ?? [])];
  }
  return out;
}

/** `frames` with `frame` at the place of the first of `at` and the others taken out. */
function replaced(frames: NamedFrame[], at: readonly number[], frame: Frame): NamedFrame[] {
  const first = at[0] as number;
  const gone = new Set(at.slice(1));
  return frames
    .map((nf, i) => (i === first ? { name: nf.name, frame } : nf))
    .filter((_, i) => !gone.has(i));
}

const tooManyResultRows = () =>
  detail("steps.result_rows", `the step would make more than ${MAX_RESULT_ROWS} rows`, {
    max: MAX_RESULT_ROWS,
  });

function stack(frames: NamedFrame[], names: readonly string[], budget: Budget): NamedFrame[] {
  const at = names.map((n) => position(frames, n));
  const fields: Field[] = [];
  for (const i of at) {
    const frame = (frames[i] as NamedFrame).frame;
    for (const f of frame.fields) {
      fieldIndex(frame, f.name);
      const g = fields.find((x) => x.name === f.name);
      if (g === undefined) {
        fields.push(copyWith(f, []));
      } else if (g.type !== f.type) {
        throw detail(
          "steps.stack_types",
          `field ${f.name} is ${g.type} in one table and ${f.type} in another`,
          { field: f.name, first: g.type, other: f.type },
        );
      } else {
        if (g.unit !== f.unit) delete g.unit;
        if (labelText(g.labels) !== labelText(f.labels)) delete g.labels;
      }
    }
  }
  const rows = at.reduce((sum, i) => sum + rowsOf((frames[i] as NamedFrame).frame), 0);
  if (rows > MAX_RESULT_ROWS) throw tooManyResultRows();
  checkCells(budget, rows, fields.length);
  let text = 0;
  for (const i of at) {
    const frame = (frames[i] as NamedFrame).frame;
    for (const g of fields) {
      const f = frame.fields.find((x) => x.name === g.name);
      if (f === undefined) {
        for (let r = 0; r < rowsOf(frame); r++) g.values.push(null);
      } else {
        for (const v of f.values) {
          text += textUnits(v);
          g.values.push(v ?? null);
        }
      }
    }
  }
  spendText(budget, text);
  const meta = joinedMeta(at.map((i) => (frames[i] as NamedFrame).frame.meta));
  return replaced(frames, at, frameOf(fields, meta));
}

/** Labels as one text, by key, so equal labels give equal text whatever order they came in. */
const labelText = (labels: Readonly<Record<string, string>> | undefined) =>
  JSON.stringify(Object.entries(labels ?? {}).sort(([a], [b]) => compareText(a, b)));

/** A series' name: the field's name and its labels, as `cpu{host="a", zone="b"}`. */
function metricName(f: Field): string {
  const labels = Object.entries(f.labels ?? {}).sort(([a], [b]) => compareText(a, b));
  if (labels.length === 0) return f.name;
  return `${f.name}{${labels.map(([k, v]) => `${k}="${v}"`).join(", ")}}`;
}

function seriesToRows(
  frames: NamedFrame[],
  names: readonly string[],
  budget: Budget,
): NamedFrame[] {
  const at = names.map((n) => position(frames, n));
  const entries: { t: number; metric: number; v: number }[] = [];
  const metrics: string[] = [];
  const valueFields: Field[] = [];
  for (const i of at) {
    const nf = frames[i] as NamedFrame;
    const t = firstTimeField(nf);
    const times = fieldAt(nf.frame, t).values;
    const series: { metric: number; f: Field }[] = [];
    nf.frame.fields.forEach((f, j) => {
      if (j === t || !isNumeric(f.type)) return;
      metrics.push(metricName(f));
      valueFields.push(f);
      series.push({ metric: metrics.length - 1, f });
    });
    times.forEach((time, row) => {
      const tm = numberAt(time);
      if (tm === null) return;
      for (const { metric, f } of series) {
        const v = numberAt(f.values[row]);
        if (v === null) continue;
        entries.push({ t: tm, metric, v });
        if (entries.length > MAX_RESULT_ROWS) throw tooManyResultRows();
      }
    });
  }
  checkCells(budget, entries.length, 3);
  entries.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  spendText(
    budget,
    entries.reduce((sum, e) => sum + (metrics[e.metric] as string).length, 0),
  );
  const value = newField(
    "value",
    "number",
    entries.map((e) => numCell(e.v)),
  );
  const unit = sharedUnit(valueFields);
  if (unit !== undefined) value.unit = unit;
  const fields = [
    newField(
      "time",
      "time",
      entries.map((e) => Math.floor(e.t)),
    ),
    newField(
      "metric",
      "string",
      entries.map((e) => metrics[e.metric]),
    ),
    value,
  ];
  const meta = joinedMeta(at.map((i) => (frames[i] as NamedFrame).frame.meta));
  return replaced(frames, at, frameOf(fields, meta));
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
