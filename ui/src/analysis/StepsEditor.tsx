import { type ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import type { Field, Frame, GraphSet, RanIn } from "../api/generated/shapes";
import { reasonText } from "../features/datasources/reasons";
import { type MessageKey, type Translate, useI18n } from "../i18n/i18n";
import { formatValue, isNumeric } from "../panels/frame";
import { DetailError, FUNCTIONS, parse } from "./expr";
import {
  type Direction,
  MAX_PAIRS,
  MAX_TOP_NODES,
  PROPERTY_OPS,
  type PropertyFilter,
  type PropertyOp,
} from "./graphSteps";
import { useAnalysisCalendar } from "./panel";
import {
  AGGS,
  type Agg,
  type Aggregation,
  GRAPH_STEP_TYPES,
  isGraphStep,
  MAX_STEPS,
  MAX_WINDOW,
  type NamedFrame,
  type NamedGraph,
  type NamedInput,
  runSteps,
  STATS,
  STEP_TYPES,
  type Step,
  type StepKind,
  type StepOutcome,
  type StepsRun,
  type StepType,
} from "./steps";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

/** Rows the preview shows. */
const PREVIEW_ROWS = 20;

interface StepsEditorProps {
  /** The stored steps; a projection (`toFrame`) is shown here, its columns are edited with the query. */
  steps: readonly Step[];
  onChange: (steps: Step[]) => void;
  /** The queries' reference ids, which steps work on. */
  refIds: readonly string[];
  /** The queries' results as answered; empty until they ran. */
  inputs: readonly NamedInput[];
  /**
   * The steps' run, when the page already has one (the panel's preview uses the same), so the
   * steps do not run twice; else the editor runs them, a moment behind typing.
   */
  run?: StepsRun | undefined;
  /** The data source kind of a query, by reference id: says where its graph steps run. */
  kindOf?: ((refId: string) => string | undefined) | undefined;
}

/** Graph steps the graph databases run themselves (server/src/analysis/pushdown.rs). */
const PUSHDOWN_KINDS: Record<string, string> = { neo4j: "Neo4j", memgraph: "Memgraph" };
const PUSHDOWN_TYPES: readonly StepType[] = [
  "countLabels",
  "countEdgeTypes",
  "degreeDistribution",
  "topDegree",
  "sharedNeighbours",
];

type ShapeName = "graph" | "frame" | "documents";

/** Graph steps that leave a graph. */
const GRAPH_TO_GRAPH: readonly StepType[] = ["topDegree", "degree", "filterGraph"];

/** The shape a step reads and the one it makes. */
function shapesOf(step: StepKind): [ShapeName, ShapeName] {
  if (GRAPH_TO_GRAPH.includes(step.type)) return ["graph", "graph"];
  if (isGraphStep(step)) return ["graph", "frame"];
  if (step.type === "toFrame") return ["documents", "frame"];
  return ["frame", "frame"];
}

/** The step's name: a projection of a graph is "In Tabelle umwandeln". */
function kindLabel(t: Translate, step: StepKind): string {
  return step.type === "toFrame" && step.rows !== undefined
    ? t("analysis.kind.graphToFrame")
    : t(`analysis.kind.${step.type}`);
}

function ShapeChip({ from, to }: { from: ShapeName; to?: ShapeName | undefined }) {
  const { t } = useI18n();
  const name = (s: ShapeName) => t(`analysis.shape.${s}`);
  return (
    <span className="shape-chip">
      {to === undefined || to === from
        ? name(from)
        : t("analysis.shape.change", { from: name(from), to: name(to) })}
    </span>
  );
}

/** A graph's size, or a table's, in words. */
function sizeText(t: Translate, shape: { graph: GraphSet } | { frame: Frame }): string {
  return "graph" in shape
    ? t("analysis.chain.graph", {
        nodes: shape.graph.nodes.length,
        edges: shape.graph.edges.length,
      })
    : t("analysis.chain.frame", {
        rows: shape.frame.fields[0]?.values.length ?? 0,
        fields: shape.frame.fields.length,
      });
}

/** What to focus after a step moved or went: a control of a step, or the step picker. */
type FocusRequest = { id: string; action: "up" | "down" | "remove" } | { id: null };

const numeric = (f: Field) => isNumeric(f.type);
const timeLike = (f: Field) => f.type === "time" || f.type === "date";

/**
 * Edits a list of analysis steps: add, reorder, turn off, remove, and a preview of the frames
 * after any step. The steps run here as they will in the panel (docs/api/settings-dashboards.md, "Analysis steps").
 */
export function StepsEditor({
  steps,
  onChange,
  refIds,
  inputs,
  run: given,
  kindOf = () => undefined,
}: StepsEditorProps) {
  const { t } = useI18n();
  const headingId = useId();
  const addId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [adding, setAdding] = useState<StepType>("calculate");
  // The step whose result the preview shows; -1 shows the queries' results.
  const [previewAt, setPreviewAt] = useState(-1);
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  // Each announcement is new to the live region, also when the words repeat (a step moved up
  // twice): the counter keys a fresh node, which screen readers read as an addition.
  const announce = (text: string) => setAnnouncement((a) => ({ text, count: a.count + 1 }));
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const frames = inputs.flatMap((i) => ("frame" in i ? [i] : []));
  const graphInputs = inputs.flatMap((i) => ("graph" in i ? [i] : []));
  // Typing stays quick: the steps run on the deferred list, a moment behind the keystrokes.
  const deferred = useDeferredValue(steps);
  const calendar = useAnalysisCalendar();
  const run = given ?? runSteps(deferred, inputs, { calendar });
  const hasData = inputs.length > 0;
  // The run may be of the list as it was a moment ago (deferred); results go by step id, so a
  // step never shows its neighbour's result after a move.
  const byId = new Map(run.steps.map((o) => [o.id, o]));
  const outcomeAt = (index: number) => {
    const step = steps[index];
    return step === undefined ? undefined : byId.get(step.id);
  };

  // A moved or removed step's control left the place it was; focus goes where the user expects.
  useEffect(() => {
    if (focus === null) return;
    const root = sectionRef.current;
    let target: HTMLElement | null | undefined;
    if (focus.id === null) {
      target = root?.querySelector<HTMLElement>("select");
    } else {
      const item = root?.querySelector(`[data-step="${CSS.escape(focus.id)}"]`);
      const wanted = item?.querySelector<HTMLButtonElement>(`[data-action="${focus.action}"]`);
      target =
        wanted !== null && wanted !== undefined && !wanted.disabled
          ? wanted
          : item?.querySelector<HTMLButtonElement>(
              `[data-action="${focus.action === "up" ? "down" : "up"}"]`,
            );
    }
    target?.focus();
    setFocus(null);
  }, [focus]);

  const update = (index: number, step: Step) =>
    onChange(steps.map((s, i) => (i === index ? step : s)));
  const move = (index: number, by: number) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    onChange(next);
    // The preview stays on the step it showed, wherever that step now is.
    if (previewAt === index) setPreviewAt(index + by);
    else if (previewAt === index + by) setPreviewAt(index);
    announce(t("analysis.steps.moved", { n: index + by + 1 }));
    setFocus({ id: step.id, action: by < 0 ? "up" : "down" });
  };
  const remove = (index: number) => {
    const next = steps.filter((_, i) => i !== index);
    onChange(next);
    if (previewAt === index) setPreviewAt(-1);
    else if (previewAt > index) setPreviewAt(previewAt - 1);
    announce(t("analysis.steps.removed", { n: index + 1 }));
    const neighbour = next[index] ?? next[index - 1];
    setFocus(neighbour === undefined ? { id: null } : { id: neighbour.id, action: "remove" });
  };
  /** The frames a step reads: what the step before it made, or the queries' results. */
  const inputOf = (index: number): readonly NamedFrame[] => {
    for (let i = index - 1; i >= 0; i--) {
      const out = outcomeAt(i)?.frames;
      if (out !== undefined) return out;
      if (outcomeAt(i)?.skipped !== true) return [];
    }
    return frames;
  };
  /** The graphs a step reads, as `inputOf` the frames. */
  const graphsOf = (index: number): readonly NamedGraph[] => {
    for (let i = index - 1; i >= 0; i--) {
      const out = outcomeAt(i)?.graphs;
      if (out !== undefined) return out;
      if (outcomeAt(i)?.skipped !== true) return [];
    }
    return graphInputs;
  };
  const previewFrames =
    previewAt < 0 ? frames : (outcomeAt(previewAt)?.frames ?? inputOf(previewAt + 1));
  const previewGraphs =
    previewAt < 0 ? graphInputs : (outcomeAt(previewAt)?.graphs ?? graphsOf(previewAt + 1));
  /**
   * Where a graph step runs: as the server said for the last run, else as it will: the first
   * graph step of a Neo4j or Memgraph query in the database, the others on the server.
   */
  const placeOf = (index: number): RanIn => {
    const step = steps[index] as Step;
    const said = outcomeAt(index)?.ranIn;
    if (said !== undefined) return said;
    const first = steps.find(
      (s) => s.disabled !== true && isGraphStep(s) && s.frame === stepTarget(step),
    );
    return first?.id === step.id &&
      PUSHDOWN_TYPES.includes(step.type) &&
      PUSHDOWN_KINDS[kindOf(stepTarget(step)) ?? ""] !== undefined
      ? "database"
      : "server";
  };
  // What may be added: graph steps while a graph is left, table steps once there is a table
  // (or before the queries ran, when nothing is known yet).
  const graphsLeft = hasData ? run.graphs.length > 0 : false;
  const tablesThere = !hasData || run.frames.length > 0 || frames.length > 0;
  const offered: StepType[] = [
    ...(graphsLeft ? GRAPH_STEP_TYPES : []),
    ...(graphsLeft ? (["toFrame"] as const) : []),
    ...(tablesThere ? STEP_TYPES.filter((type) => type !== "join" || refIds.length > 1) : []),
  ];
  const chosen = offered.includes(adding) ? adding : offered[0];

  return (
    <section className="steps" aria-labelledby={headingId} ref={sectionRef}>
      <p className="visually-hidden" aria-live="polite">
        <span key={announcement.count}>{announcement.text}</span>
      </p>
      <h3 className="steps__heading" id={headingId}>
        {t("analysis.steps.title")}
      </h3>
      <p className="field__hint">{t("analysis.steps.lead")}</p>
      {steps.length === 0 ? <p className="field__hint">{t("analysis.steps.empty")}</p> : null}
      <ol className="steps__list">
        {steps.map((step, index) => {
          const outcome = outcomeAt(index);
          const n = index + 1;
          let status: ReactNode;
          if (step.disabled === true) {
            status = t("analysis.steps.status.off");
          } else if (outcome?.error !== undefined) {
            status = (
              <span className="steps__error">
                {reasonText(t, {
                  reason: outcome.error.reason,
                  params: outcome.error.params,
                  fallback: outcome.error.message,
                }) ?? outcome.error.message}
              </span>
            );
          } else if (!hasData) {
            status = t("analysis.steps.status.noData");
          } else if (outcome?.skipped === true) {
            status = t("analysis.steps.status.notRun");
          } else {
            const graph = outcome?.graphs?.find((g) => stepTarget(step) === g.name)?.graph;
            const target = outcome?.frames?.find((f) => stepTarget(step) === f.name)?.frame;
            status =
              graph !== undefined
                ? t("analysis.chain.graph", {
                    nodes: graph.nodes.length,
                    edges: graph.edges.length,
                  })
                : t("analysis.steps.status.rows", {
                    rows: target?.fields[0]?.values.length ?? 0,
                    fields: target?.fields.length ?? 0,
                  });
          }
          const [from, to] = shapesOf(step);
          const where = isGraphStep(step)
            ? placeOf(index) === "database"
              ? t("analysis.where.database", {
                  engine: PUSHDOWN_KINDS[kindOf(stepTarget(step)) ?? ""] ?? "",
                })
              : t("analysis.where.server")
            : t("analysis.where.browser");
          return (
            <li
              key={step.id}
              className="step"
              aria-label={t("analysis.steps.number", { n })}
              data-step={step.id}
            >
              <div className="step__header">
                <span className="step__number">{n}</span>
                <span className="step__title">{kindLabel(t, step)}</span>
                <ShapeChip from={shapesOf(step)[0]} to={shapesOf(step)[1]} />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={step.disabled !== true}
                    onChange={(event) => {
                      const { disabled: _, ...rest } = step;
                      update(
                        index,
                        event.currentTarget.checked ? (rest as Step) : { ...step, disabled: true },
                      );
                    }}
                  />
                  <span>{t("analysis.steps.enabled")}</span>
                </label>
                <div className="step__actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-pressed={previewAt === index}
                    aria-label={t("analysis.steps.previewNamed", { n })}
                    onClick={() => setPreviewAt(previewAt === index ? -1 : index)}
                  >
                    {t("analysis.steps.preview")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.up", { n })}
                    data-action="up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.down", { n })}
                    data-action="down"
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.removeNamed", { n })}
                    data-action="remove"
                    onClick={() => remove(index)}
                  >
                    {t("analysis.steps.remove")}
                  </button>
                </div>
              </div>
              <StepForm
                step={step}
                onChange={(next) => update(index, next)}
                refIds={refIds}
                input={inputOf(index)}
                graphs={graphsOf(index)}
              />
              <p className="step__status">{status}</p>
              <p className="step__where">
                {from === to ? where : t("analysis.where.changes", { where })}
              </p>
            </li>
          );
        })}
      </ol>
      {steps.some(isGraphStep) ? (
        <ShapeChain steps={steps} graphs={graphInputs} outcomeOf={(id) => byId.get(id)} />
      ) : null}
      {steps.length < MAX_STEPS && chosen !== undefined ? (
        <div className="steps__add">
          <label className="visually-hidden" htmlFor={addId}>
            {t("analysis.steps.addType")}
          </label>
          <select
            id={addId}
            className="select"
            value={chosen}
            aria-describedby={`${addId}-about`}
            onChange={(event) => setAdding(event.currentTarget.value as StepType)}
          >
            {graphsLeft ? (
              <optgroup label={t("analysis.catalog.graph")}>
                {[...GRAPH_STEP_TYPES, "toFrame" as const].map((type) => (
                  <option key={type} value={type}>
                    {type === "toFrame"
                      ? t("analysis.kind.graphToFrame")
                      : t(`analysis.kind.${type}`)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {tablesThere ? (
              <optgroup label={t("analysis.catalog.table")}>
                {STEP_TYPES.filter((type) => type !== "join" || refIds.length > 1).map((type) => (
                  <option key={type} value={type}>
                    {t(`analysis.kind.${type}`)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              const input = run.frames.length > 0 ? run.frames : frames;
              onChange([...steps, newStep(chosen, refIds, input, t, run.graphs)]);
            }}
          >
            {t("analysis.steps.add")}
          </button>
          <p className="field__hint steps__about" id={`${addId}-about`}>
            <ShapeChip
              from={
                GRAPH_STEP_TYPES.includes(chosen as never) || chosen === "toFrame"
                  ? "graph"
                  : "frame"
              }
              to={GRAPH_TO_GRAPH.includes(chosen) ? "graph" : "frame"}
            />{" "}
            {t(`analysis.about.${chosen}` as MessageKey)}
            {tablesThere ? null : ` ${t("analysis.catalog.tablesLater")}`}
          </p>
        </div>
      ) : null}
      {steps.length > 0 ? (
        <Preview
          graphs={previewGraphs}
          frames={previewFrames}
          title={
            previewAt < 0
              ? t("analysis.preview.input")
              : t("analysis.preview.after", { n: previewAt + 1 })
          }
          onShowInput={previewAt < 0 ? undefined : () => setPreviewAt(-1)}
        />
      ) : null}
    </section>
  );
}

/** The frame a step writes. */
function stepTarget(step: StepKind): string {
  return step.type === "join" ? step.left : step.frame;
}

/** A new step of a kind, filled in from the frames (or the graphs) it will read. */
export function newStep(
  type: StepType,
  refIds: readonly string[],
  input: readonly NamedFrame[],
  t: Translate,
  graphs: readonly NamedGraph[] = [],
): Step {
  const id = crypto.randomUUID();
  const frame = refIds[0] ?? "A";
  const graph = graphs[0] ?? { name: frame, graph: EMPTY_GRAPH };
  if (type === "toFrame" && graphs.length > 0) return newGraphStep(id, type, graph);
  const fields = input.find((f) => f.name === frame)?.frame.fields ?? [];
  const firstNumber = fields.find(numeric)?.name ?? "";
  const firstOther = fields.find((f) => !numeric(f) && !timeLike(f))?.name ?? "";
  switch (type) {
    case "toFrame":
      // Not offered here: the query's editor picks the columns of a projection.
      return { id, type, frame, columns: [] };
    case "calculate":
      return { id, type, frame, name: t("analysis.default.calculate"), expression: firstNumber };
    case "join":
      return {
        id,
        type,
        left: frame,
        right: refIds[1] ?? frame,
        on: { by: "time" },
        mode: "outer",
      };
    case "reduce":
      return {
        id,
        type,
        frame,
        fields: firstNumber === "" ? [] : [firstNumber],
        stats: ["sum", "mean", "min", "max"],
      };
    case "trend":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        output: "fitted",
        name: t("analysis.default.trend"),
      };
    case "movingAverage":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        window: 7,
        name: t("analysis.default.movingAverage"),
      };
    case "correlate":
      return {
        id,
        type,
        frame,
        x: firstNumber,
        y: fields.filter(numeric)[1]?.name ?? firstNumber,
      };
    case "compare":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        period: "week",
        output: "difference",
        name: t("analysis.default.compare"),
      };
    case "group":
      return {
        id,
        type,
        frame,
        by: firstOther === "" ? [] : [firstOther],
        aggregations: firstNumber === "" ? [] : [{ field: firstNumber, op: "sum" }],
      };
    case "pivot":
      return {
        id,
        type,
        frame,
        row: firstOther,
        column: fields.filter((f) => !numeric(f) && !timeLike(f))[1]?.name ?? firstOther,
        value: firstNumber,
        op: "sum",
      };
    default:
      return newGraphStep(id, type, graph);
  }
}

const EMPTY_GRAPH: GraphSet = {
  nodes: [],
  edges: [],
  schema: { labels: [], edgeTypes: [], propertyKeys: {} },
};

/** A new graph step on `graph`, filled in from its labels and property keys. */
function newGraphStep(id: string, type: StepType, { name: frame, graph }: NamedGraph): Step {
  const labels = graph.schema.labels;
  const keys = graph.schema.propertyKeys;
  switch (type) {
    case "countLabels":
    case "countEdgeTypes":
      return { id, type, frame };
    case "degreeDistribution":
      return { id, type, frame, direction: "both" };
    case "topDegree":
      return { id, type, frame, n: 10, direction: "both" };
    case "degree":
      return { id, type, frame, direction: "both" };
    case "filterGraph":
      return { id, type, frame };
    case "sharedNeighbours": {
      const label = labels[0] ?? "";
      return {
        id,
        type,
        frame,
        label,
        via: labels[1] ?? "",
        min: 1,
        limit: 10,
        ...((keys[label] ?? []).includes("name") ? { name: "name" } : {}),
      };
    }
    default: {
      const label = labels[0];
      const own = (label === undefined ? [] : (keys[label] ?? [])).slice(0, 3);
      return {
        id,
        type: "toFrame",
        frame,
        rows: "nodes",
        ...(label === undefined ? {} : { label }),
        columns: [{ path: "@id" }, ...own.map((path) => ({ path }))],
      };
    }
  }
}

// ---- forms ----

interface FormProps {
  step: Step;
  onChange: (step: Step) => void;
  refIds: readonly string[];
  input: readonly NamedFrame[];
  /** The graphs the step reads. */
  graphs: readonly NamedGraph[];
}

function StepForm({ step, onChange, refIds, input, graphs }: FormProps) {
  const { t } = useI18n();
  const fieldsOf = (name: string) => input.find((f) => f.name === name)?.frame.fields ?? [];
  // Each kind's own fields; the shared frame choice comes first.
  const set = <K extends StepKind>(patch: Partial<K>) => onChange({ ...step, ...patch } as Step);
  const frameChoice =
    step.type === "join" ? null : (
      <Choice
        label={t("analysis.field.frame")}
        value={step.frame}
        options={refIds.map((r) => [r, r])}
        onChange={(frame) => set({ frame })}
        hidden={refIds.length < 2}
      />
    );
  if (isGraphStep(step)) {
    const graph = graphs.find((g) => g.name === step.frame)?.graph;
    return (
      <GraphStepForm step={step} graph={graph} frameChoice={frameChoice} onChange={onChange} />
    );
  }
  switch (step.type) {
    case "toFrame":
      return (
        <div className="step__form">
          <p className="field__hint step__wide">
            {t("analysis.toFrame.columns", {
              frame: step.frame,
              columns: step.columns.map((c) => c.name ?? c.path).join(", "),
            })}
          </p>
        </div>
      );
    case "calculate":
      return (
        <div className="step__form">
          {frameChoice}
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
          <ExpressionField step={step} onChange={(expression) => set({ expression })} />
        </div>
      );
    case "join": {
      const on = step.on;
      return (
        <div className="step__form">
          <Choice
            label={t("analysis.field.left")}
            value={step.left}
            options={refIds.map((r) => [r, r])}
            onChange={(left) => set({ left })}
          />
          <Choice
            label={t("analysis.field.right")}
            value={step.right}
            options={refIds.map((r) => [r, r])}
            onChange={(right) => set({ right })}
          />
          <Choice
            label={t("analysis.field.on")}
            value={on.by}
            options={[
              ["time", t("analysis.on.time")],
              ["key", t("analysis.on.key")],
            ]}
            onChange={(by) =>
              set({
                on: by === "time" ? { by: "time" } : { by: "key", leftField: "", rightField: "" },
              })
            }
          />
          {on.by === "key" ? (
            <>
              <FieldChoice
                label={t("analysis.field.leftField")}
                value={on.leftField}
                fields={fieldsOf(step.left)}
                onChange={(leftField) => set({ on: { ...on, leftField } })}
              />
              <FieldChoice
                label={t("analysis.field.rightField")}
                value={on.rightField}
                fields={fieldsOf(step.right)}
                onChange={(rightField) => set({ on: { ...on, rightField } })}
              />
            </>
          ) : null}
          <Choice
            label={t("analysis.field.mode")}
            value={step.mode}
            options={(["inner", "left", "outer"] as const).map((m) => [m, t(`analysis.mode.${m}`)])}
            onChange={(mode) => set({ mode: mode as typeof step.mode })}
          />
        </div>
      );
    }
    case "reduce": {
      const fields = fieldsOf(step.frame).filter(numeric);
      return (
        <div className="step__form">
          {frameChoice}
          <Checks
            legend={t("analysis.field.fields")}
            options={withCurrent(
              fields.map((f) => f.name),
              step.fields,
            ).map((n) => [n, n])}
            value={step.fields}
            onChange={(selected) => set({ fields: selected })}
          />
          <Checks
            legend={t("analysis.field.stats")}
            options={STATS.map((s) => [s, t(`analysis.stat.${s}`)])}
            value={step.stats}
            onChange={(selected) => {
              const stats = STATS.filter((s) => selected.includes(s));
              const next: Partial<typeof step> = { stats };
              if (stats.includes("percentile") && (step.percentiles ?? []).length === 0) {
                next.percentiles = [90];
              }
              if (!stats.includes("percentile")) next.percentiles = [];
              set(next);
            }}
          />
          {step.stats.includes("percentile") ? (
            <PercentilesField
              value={step.percentiles ?? []}
              onChange={(percentiles) => set({ percentiles })}
            />
          ) : null}
        </div>
      );
    }
    case "trend":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <FieldChoice
            label={t("analysis.field.x")}
            value={step.x ?? ""}
            fields={fieldsOf(step.frame).filter((f) => numeric(f) || timeLike(f))}
            empty={t("analysis.field.xDefault")}
            onChange={(x) => {
              const { x: _, ...rest } = step;
              onChange(x === "" ? (rest as Step) : { ...step, x });
            }}
          />
          <Choice
            label={t("analysis.field.output")}
            value={step.output}
            options={[
              ["fitted", t("analysis.trend.fitted")],
              ["summary", t("analysis.trend.summary")],
            ]}
            onChange={(output) => {
              const { name: _, ...rest } = step;
              onChange(
                output === "summary"
                  ? ({ ...rest, output: "summary" } as Step)
                  : { ...step, output: "fitted", name: step.name ?? t("analysis.default.trend") },
              );
            }}
          />
          {step.output === "fitted" ? (
            <Text
              label={t("analysis.field.name")}
              value={step.name ?? ""}
              onChange={(name) => set({ name })}
            />
          ) : null}
        </div>
      );
    case "movingAverage":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <NumberField
            label={t("analysis.field.window")}
            value={step.window}
            min={1}
            max={MAX_WINDOW}
            onChange={(window) => set({ window })}
          />
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
        </div>
      );
    case "correlate":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.corrX")}
            value={step.x}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(x) => set({ x })}
          />
          <FieldChoice
            label={t("analysis.field.corrY")}
            value={step.y}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(y) => set({ y })}
          />
        </div>
      );
    case "compare":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <FieldChoice
            label={t("analysis.field.time")}
            value={step.time ?? ""}
            fields={fieldsOf(step.frame).filter(timeLike)}
            empty={t("analysis.field.timeDefault")}
            onChange={(time) => {
              const { time: _, ...rest } = step;
              onChange(time === "" ? (rest as Step) : { ...step, time });
            }}
          />
          <Choice
            label={t("analysis.field.period")}
            value={step.period}
            options={(["week", "month", "year"] as const).map((p) => [
              p,
              t(`analysis.period.${p}`),
            ])}
            onChange={(period) => set({ period: period as typeof step.period })}
          />
          <Choice
            label={t("analysis.field.output")}
            value={step.output}
            options={(["previous", "difference", "percent"] as const).map((o) => [
              o,
              t(`analysis.compare.${o}`),
            ])}
            onChange={(output) => set({ output: output as typeof step.output })}
          />
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
          <p className="field__hint step__wide">{t("analysis.compare.hint")}</p>
        </div>
      );
    case "group":
      return (
        <GroupForm
          step={step}
          fields={fieldsOf(step.frame)}
          frameChoice={frameChoice}
          onChange={(next) => onChange({ ...step, ...next })}
        />
      );
    case "pivot": {
      const fields = fieldsOf(step.frame);
      const keys = fields.filter((f) => f.type !== "json");
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.row")}
            value={step.row}
            fields={keys}
            onChange={(row) => set({ row })}
          />
          <FieldChoice
            label={t("analysis.field.column")}
            value={step.column}
            fields={keys}
            onChange={(column) => set({ column })}
          />
          <FieldChoice
            label={t("analysis.field.value")}
            value={step.value}
            fields={fields}
            onChange={(value) => set({ value })}
          />
          <Choice
            label={t("analysis.field.op")}
            value={step.op}
            options={AGGS.map((a) => [a, aggLabel(t, a)])}
            onChange={(op) => set({ op: op as Agg })}
          />
        </div>
      );
    }
    default:
      return null;
  }
}

/** Without `key` when `value` is empty: optional fields are left out, not stored empty. */
function optional<S extends Step>(step: S, key: string, value: string): S {
  const { [key]: _, ...rest } = step as Record<string, unknown>;
  return (value === "" ? rest : { ...rest, [key]: value }) as S;
}

const DIRECTIONS: readonly Direction[] = ["both", "out", "in"];

/** Without `key` when the list is empty. */
function optionalList<S extends Step>(step: S, key: string, value: string[]): S {
  const { [key]: _, ...rest } = step as Record<string, unknown>;
  return (value.length === 0 ? rest : { ...rest, [key]: value }) as S;
}

/** The value of a condition as typed: a number for comparisons, else text ("true" and "false" as such). */
function valueFor(op: PropertyOp, text: string): { value?: string | number | boolean } {
  const t = text.trim();
  if (t === "") return {};
  const n = Number(t.replace(",", "."));
  if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
    return Number.isFinite(n) ? { value: n } : {};
  }
  if (op === "contains") return { value: text };
  if (t === "true" || t === "false") return { value: t === "true" };
  return Number.isFinite(n) && /^[+-]?[\d.,]+$/.test(t) ? { value: n } : { value: text };
}

function keptValue(filter: PropertyFilter | undefined): { value?: string | number | boolean } {
  return filter?.value === undefined ? {} : { value: filter.value };
}

function GraphStepForm({
  step,
  graph,
  frameChoice,
  onChange,
}: {
  step: Step;
  graph: GraphSet | undefined;
  frameChoice: ReactNode;
  onChange: (step: Step) => void;
}) {
  const { t } = useI18n();
  const labels = graph?.schema.labels ?? [];
  const types = graph?.schema.edgeTypes ?? [];
  const keys = graph?.schema.propertyKeys ?? {};
  const allKeys = [...new Set(Object.values(keys).flat())].sort();
  const options = (values: readonly string[], none?: string): [string, string][] => [
    ...(none === undefined ? [] : [["", none] as [string, string]]),
    ...values.map((v): [string, string] => [v, v]),
  ];
  const direction = (value: Direction | undefined, set: (d: Direction) => void) => (
    <Choice
      label={t("analysis.graph.direction")}
      value={value ?? "both"}
      options={DIRECTIONS.map((d) => [d, t(`analysis.direction.${d}`)])}
      onChange={(d) => set(d as Direction)}
    />
  );
  const hint = (text: string) => <p className="field__hint step__wide">{text}</p>;
  switch (step.type) {
    case "countLabels":
    case "countEdgeTypes":
      return (
        <div className="step__form">
          {frameChoice}
          {hint(t(`analysis.graph.fields.${step.type}`))}
        </div>
      );
    case "degreeDistribution":
      return (
        <div className="step__form">
          {frameChoice}
          {direction(step.direction, (d) => onChange({ ...step, direction: d }))}
          {hint(t("analysis.graph.fields.degreeDistribution"))}
        </div>
      );
    case "topDegree":
      return (
        <div className="step__form">
          {frameChoice}
          <NumberField
            label={t("analysis.graph.n")}
            value={step.n}
            min={1}
            max={MAX_TOP_NODES}
            onChange={(n) => onChange({ ...step, n })}
          />
          <Choice
            label={t("analysis.graph.label")}
            value={step.label ?? ""}
            options={options(labels, t("analysis.graph.allLabels"))}
            onChange={(label) => onChange(optional(step, "label", label))}
          />
          {direction(step.direction, (d) => onChange({ ...step, direction: d }))}
          {hint(t("analysis.graph.fields.topDegree"))}
        </div>
      );
    case "sharedNeighbours":
      return (
        <div className="step__form">
          {frameChoice}
          <Choice
            label={t("analysis.graph.pairsOf")}
            value={step.label}
            options={options(labels)}
            onChange={(label) => onChange({ ...step, label })}
          />
          <Choice
            label={t("analysis.graph.via")}
            value={step.via}
            options={options(labels.filter((l) => l !== step.label))}
            onChange={(via) => onChange({ ...step, via })}
          />
          <Choice
            label={t("analysis.graph.edgeType")}
            value={step.edgeType ?? ""}
            options={options(types, t("analysis.graph.allEdgeTypes"))}
            onChange={(edgeType) => onChange(optional(step, "edgeType", edgeType))}
          />
          <NumberField
            label={t("analysis.graph.min")}
            value={step.min}
            min={1}
            max={MAX_PAIRS}
            onChange={(min) => onChange({ ...step, min })}
          />
          <NumberField
            label={t("analysis.graph.limit")}
            value={step.limit}
            min={1}
            max={MAX_PAIRS}
            onChange={(limit) => onChange({ ...step, limit })}
          />
          <Choice
            label={t("analysis.graph.nameBy")}
            value={step.name ?? ""}
            options={options(keys[step.label] ?? allKeys, t("analysis.graph.nameById"))}
            onChange={(name) => onChange(optional(step, "name", name))}
          />
          {hint(t("analysis.graph.fields.sharedNeighbours"))}
        </div>
      );
    case "degree":
      return (
        <div className="step__form">
          {frameChoice}
          {direction(step.direction, (d) => onChange({ ...step, direction: d }))}
          <Text
            label={t("analysis.graph.property")}
            value={step.name ?? "degree"}
            onChange={(name) => onChange(optional(step, "name", name === "degree" ? "" : name))}
          />
          {hint(t("analysis.graph.fields.degree"))}
        </div>
      );
    case "filterGraph": {
      const filter = step.property;
      const setFilter = (next: PropertyFilter | undefined) => {
        const { property: _, ...rest } = step;
        onChange(next === undefined ? rest : { ...rest, property: next });
      };
      const valueText = filter?.value === undefined ? "" : String(filter.value);
      return (
        <div className="step__form">
          {frameChoice}
          <Checks
            legend={t("analysis.graph.labels")}
            options={withCurrent(labels, step.labels ?? []).map((l) => [l, l])}
            value={step.labels ?? []}
            onChange={(next) => onChange(optionalList(step, "labels", next))}
          />
          <Checks
            legend={t("analysis.graph.edgeTypes")}
            options={withCurrent(types, step.edgeTypes ?? []).map((l) => [l, l])}
            value={step.edgeTypes ?? []}
            onChange={(next) => onChange(optionalList(step, "edgeTypes", next))}
          />
          <Choice
            label={t("analysis.graph.propertyKey")}
            value={filter?.key ?? ""}
            options={options(allKeys, t("analysis.graph.noCondition"))}
            onChange={(key) =>
              setFilter(
                key === "" ? undefined : { key, op: filter?.op ?? "exists", ...keptValue(filter) },
              )
            }
          />
          {filter === undefined ? null : (
            <>
              <Choice
                label={t("analysis.graph.op")}
                value={filter.op}
                options={PROPERTY_OPS.map((op) => [op, t(`analysis.op.${op}`)])}
                onChange={(op) => {
                  const next = op as PropertyOp;
                  setFilter(
                    next === "exists"
                      ? { key: filter.key, op: next }
                      : { key: filter.key, op: next, ...valueFor(next, valueText) },
                  );
                }}
              />
              {filter.op === "exists" ? null : (
                <Text
                  label={t("analysis.graph.value")}
                  value={valueText}
                  onChange={(text) =>
                    setFilter({ key: filter.key, op: filter.op, ...valueFor(filter.op, text) })
                  }
                />
              )}
            </>
          )}
          {hint(t("analysis.graph.fields.filterGraph"))}
        </div>
      );
    }
    case "toFrame": {
      const rows = step.rows ?? "nodes";
      const own =
        rows === "nodes"
          ? ["@id", "@labels", ...(step.label === undefined ? allKeys : (keys[step.label] ?? []))]
          : ["@id", "@type", "@from", "@to"];
      const chosenPaths = step.columns.map((c) => c.path);
      return (
        <div className="step__form">
          {frameChoice}
          <Choice
            label={t("analysis.graph.rows")}
            value={rows}
            options={[
              ["nodes", t("analysis.graph.rows.nodes")],
              ["edges", t("analysis.graph.rows.edges")],
            ]}
            onChange={(next) => {
              const { label: _l, edgeType: _e, ...rest } = step;
              onChange({ ...rest, rows: next as "nodes" | "edges", columns: [{ path: "@id" }] });
            }}
          />
          {rows === "nodes" ? (
            <Choice
              label={t("analysis.graph.label")}
              value={step.label ?? ""}
              options={options(labels, t("analysis.graph.allLabels"))}
              onChange={(label) => onChange(optional(step, "label", label))}
            />
          ) : (
            <Choice
              label={t("analysis.graph.edgeType")}
              value={step.edgeType ?? ""}
              options={options(types, t("analysis.graph.allEdgeTypes"))}
              onChange={(edgeType) => onChange(optional(step, "edgeType", edgeType))}
            />
          )}
          <Checks
            legend={t("analysis.graph.columns")}
            options={withCurrent(own, chosenPaths).map((k) => [k, k])}
            value={chosenPaths}
            onChange={(paths) =>
              onChange({
                ...step,
                columns: paths.map((path) => step.columns.find((c) => c.path === path) ?? { path }),
              })
            }
          />
          {hint(t("analysis.graph.fields.toFrame"))}
        </div>
      );
    }
    default:
      return null;
  }
}

/**
 * The shapes the steps pass on, per query with graph steps: "Graph, 1.284 nodes" → "3 Shared
 * neighbours" → "Table, 10 rows". A shape change is never silent.
 */
function ShapeChain({
  steps,
  graphs,
  outcomeOf,
}: {
  steps: readonly Step[];
  graphs: readonly NamedGraph[];
  outcomeOf: (id: string) => StepOutcome | undefined;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <div className="steps__chain">
      <span className="field__hint" id={titleId}>
        {t("analysis.chain.title")}
      </span>
      {graphs.map(({ name, graph }) => {
        const own = steps.map((s, i) => [s, i] as const).filter(([s]) => stepTarget(s) === name);
        return (
          <ol key={name} className="steps__chain-list" aria-labelledby={titleId}>
            <li className="steps__chain-node">
              <span className="steps__chain-shape">{t("analysis.shape.graph")}</span>
              <span className="steps__chain-size">{sizeText(t, { graph })}</span>
            </li>
            {own.map(([s, i]) => {
              const outcome = outcomeOf(s.id);
              const label = t("analysis.chain.step", { n: i + 1, title: kindLabel(t, s) });
              if (s.disabled === true) {
                return (
                  <li key={s.id} className="steps__chain-off">
                    {t("analysis.chain.off", { step: label })}
                  </li>
                );
              }
              const after =
                outcome?.graphs?.find((g) => g.name === name) ??
                outcome?.frames?.find((f) => f.name === name);
              return (
                <li key={s.id} className="steps__chain-pair">
                  <span className="steps__chain-step">
                    <span aria-hidden="true">→</span> {label} <span aria-hidden="true">→</span>
                  </span>
                  <span className="steps__chain-node">
                    <span className="steps__chain-shape">
                      {t(
                        `analysis.shape.${after === undefined ? shapesOf(s)[1] : "graph" in after ? "graph" : "frame"}`,
                      )}
                    </span>
                    <span className="steps__chain-size">
                      {after === undefined ? t("analysis.chain.unknown") : sizeText(t, after)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        );
      })}
    </div>
  );
}

function aggLabel(t: Translate, op: Agg): string {
  return t(`analysis.stat.${op}` as MessageKey);
}

/** The options, plus the current values a stale list lacks, so nothing is lost silently. */
function withCurrent(options: readonly string[], current: readonly string[]): string[] {
  return [...options, ...current.filter((c) => c !== "" && !options.includes(c))];
}

function GroupForm({
  step,
  fields,
  frameChoice,
  onChange,
}: {
  step: Extract<Step, { type: "group" }>;
  fields: readonly Field[];
  frameChoice: ReactNode;
  onChange: (patch: { by?: string[]; aggregations?: Aggregation[] }) => void;
}) {
  const { t } = useI18n();
  const legendId = useId();
  const keys = fields.filter((f) => f.type !== "json").map((f) => f.name);
  const setAgg = (index: number, patch: Partial<Aggregation>) =>
    onChange({
      aggregations: step.aggregations.map((a, i) => {
        if (i !== index) return a;
        const next = { ...a, ...patch };
        if (next.name === "") delete next.name;
        return next;
      }),
    });
  return (
    <div className="step__form">
      {frameChoice}
      <Checks
        legend={t("analysis.field.by")}
        options={withCurrent(keys, step.by).map((n) => [n, n])}
        value={step.by}
        onChange={(by) => onChange({ by })}
      />
      <fieldset className="step__aggregations" aria-labelledby={legendId}>
        <span className="field__label" id={legendId}>
          {t("analysis.field.aggregations")}
        </span>
        {step.aggregations.map((a, i) => (
          // The list has no ids; position is what the user edits.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
          <div className="step__aggregation" key={i}>
            <FieldChoice
              label={t("analysis.field.field")}
              value={a.field}
              fields={fields}
              onChange={(field) => setAgg(i, { field })}
            />
            <Choice
              label={t("analysis.field.op")}
              value={a.op}
              options={AGGS.map((op) => [op, aggLabel(t, op)])}
              onChange={(op) => setAgg(i, { op: op as Agg })}
            />
            <Text
              label={t("analysis.field.aggName")}
              value={a.name ?? ""}
              onChange={(name) => setAgg(i, { name })}
            />
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label={t("analysis.group.remove", { n: i + 1 })}
              onClick={() =>
                onChange({ aggregations: step.aggregations.filter((_, j) => j !== i) })
              }
            >
              {t("analysis.steps.remove")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() =>
            onChange({
              aggregations: [
                ...step.aggregations,
                { field: fields.find(numeric)?.name ?? fields[0]?.name ?? "", op: "sum" },
              ],
            })
          }
        >
          {t("analysis.group.add")}
        </button>
      </fieldset>
    </div>
  );
}

function ExpressionField({
  step,
  onChange,
}: {
  step: Extract<Step, { type: "calculate" }>;
  onChange: (expression: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  let syntaxError: string | null = null;
  try {
    parse(step.expression);
  } catch (e) {
    if (e instanceof DetailError) {
      syntaxError =
        reasonText(t, { reason: e.detail.reason, params: e.detail.params, fallback: e.message }) ??
        e.message;
    }
  }
  return (
    <div className="field step__wide">
      <label className="field__label" htmlFor={id}>
        {t("analysis.field.expression")}
      </label>
      <textarea
        id={id}
        className="input input--mono step__expression"
        value={step.expression}
        spellCheck={false}
        aria-invalid={syntaxError !== null}
        aria-describedby={`${id}-help${syntaxError === null ? "" : ` ${id}-error`}`}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {syntaxError === null ? null : (
        <p className="field__error" id={`${id}-error`}>
          {syntaxError}
        </p>
      )}
      <p className="field__hint" id={`${id}-help`}>
        {t("analysis.field.expressionHelp", {
          functions: FUNCTIONS.map(([name]) => (name === "startof" ? "startOf" : name)).join(", "),
        })}
      </p>
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const n = Math.round(Number(event.currentTarget.value));
          if (Number.isFinite(n)) onChange(Math.min(Math.max(n, min), max));
        }}
      />
    </div>
  );
}

function PercentilesField({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (value: number[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(value.join(", "));
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("analysis.field.percentiles")}
      </label>
      <input
        id={id}
        className="input"
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          // "90, 99" and "90 99,5" both read: spaces or semicolons separate, a comma inside a
          // number is the German decimal mark.
          const parsed = next
            .split(/[\s;]+/)
            .map((p) => p.replace(/,$/, "").replace(",", "."))
            .filter((p) => p !== "")
            .map(Number)
            .filter(
              (p, i, all) => Number.isFinite(p) && p >= 0 && p <= 100 && all.indexOf(p) === i,
            );
          if (parsed.length > 0) onChange(parsed.slice(0, 10));
        }}
      />
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  hidden = false,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  hidden?: boolean;
}) {
  const id = useId();
  if (hidden) return null;
  const list = options.some(([v]) => v === value) ? options : [[value, value] as const, ...options];
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {list.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A field of the step's input; free text until the query ran and its fields are known. */
function FieldChoice({
  label,
  value,
  fields,
  onChange,
  empty,
}: {
  label: string;
  value: string;
  fields: readonly Field[];
  onChange: (value: string) => void;
  /** Offers "none" with this text (an optional field). */
  empty?: string;
}) {
  if (fields.length === 0) {
    return <Text label={label} value={value} onChange={onChange} />;
  }
  const names = withCurrent(
    fields.map((f) => f.name),
    [value],
  );
  const options: [string, string][] = names.map((n) => [n, n]);
  if (empty !== undefined) options.unshift(["", empty]);
  return <Choice label={label} value={value} options={options} onChange={onChange} />;
}

function Checks({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly (readonly [string, string])[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="step__checks step__wide">
      <legend className="field__label">{legend}</legend>
      {options.map(([v, text]) => (
        <label key={v} className="checkbox">
          <input
            type="checkbox"
            checked={value.includes(v)}
            onChange={(event) =>
              onChange(event.currentTarget.checked ? [...value, v] : value.filter((x) => x !== v))
            }
          />
          <span>{text}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---- preview ----

function Preview({
  frames,
  graphs,
  title,
  onShowInput,
}: {
  frames: readonly NamedFrame[];
  graphs: readonly NamedGraph[];
  title: string;
  onShowInput: (() => void) | undefined;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const current = frames.find((f) => f.name === chosen) ?? frames[0];
  return (
    <section className="steps__preview" aria-labelledby={`${id}-title`}>
      <div className="steps__preview-bar">
        <h4 className="steps__heading" id={`${id}-title`}>
          {title}
        </h4>
        {frames.length > 1 ? (
          <Choice
            label={t("analysis.preview.frame")}
            value={current?.name ?? ""}
            options={frames.map((f) => [f.name, f.name])}
            onChange={setChosen}
          />
        ) : null}
        {onShowInput === undefined ? null : (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onShowInput}
          >
            {t("analysis.preview.showInput")}
          </button>
        )}
      </div>
      {graphs.map(({ name, graph }) => (
        <p key={name} className="field__hint">
          {t("analysis.preview.graph", {
            name,
            size: sizeText(t, { graph }),
          })}
        </p>
      ))}
      {current === undefined ? (
        graphs.length > 0 ? null : (
          <p className="field__hint">{t("analysis.preview.none")}</p>
        )
      ) : (
        <PreviewTable frame={current.frame} language={language} />
      )}
    </section>
  );
}

function PreviewTable({ frame, language }: { frame: Frame; language: string }) {
  const { t } = useI18n();
  const rows = frame.fields[0]?.values.length ?? 0;
  const shown = Math.min(rows, PREVIEW_ROWS);
  if (rows === 0) return <p className="field__hint">{t("analysis.preview.empty")}</p>;
  return (
    <div className="steps__table">
      <table className="data-table">
        <thead>
          <tr>
            {frame.fields.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
              <th key={i} scope="col">
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: shown }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
            <tr key={row}>
              {frame.fields.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
                <td key={i}>{formatValue(f.type, f.values[row], language)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows > shown ? (
        <p className="field__hint">{t("analysis.preview.rows", { shown, rows })}</p>
      ) : null}
    </div>
  );
}
