import { type ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import type { Field, Frame, GraphSet, RanIn } from "../api/generated/shapes";
import { LazyPiece, pieceSource } from "../components/LazyPiece";
import { reasonText } from "../features/datasources/reasons";
import { hasMessage, loadArea, type MessageKey, type Translate, useI18n } from "../i18n/i18n";
import { formatValue, isNumeric } from "../panels/frame";
import { AlgoOutcome, type ResultUse } from "./AlgoOutcome";
import { AlgoStepForm } from "./AlgoStepForm";
import {
  type AlgoStepKind,
  algoMakesTable,
  GRAPH_VARIANTS,
  type GraphVariant,
  isAlgoType,
  LIBRARY_NAMES,
  newAlgoStep,
  plannedPlace,
  variantOf,
} from "./algoSteps";
import { placeBadge, summarySentence } from "./algoText";
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
  type BeforeStep,
  type CatalogEntry,
  type CatalogGroup,
  ShapeChip,
  type ShapeName,
  StepCatalog,
  type StepPreview,
} from "./StepCatalog";
import {
  AGGS,
  type Agg,
  type Aggregation,
  GRAPH_STEP_TYPES,
  isAlgoStep,
  isGraphStep,
  isTraceStep,
  MAX_SORT_KEYS,
  MAX_STEPS,
  MAX_WINDOW,
  type NamedFrame,
  type NamedGraph,
  type NamedInput,
  type NamedTrace,
  runSteps,
  type SortKey,
  STATS,
  STEP_TYPES,
  type Step,
  type StepKind,
  type StepOutcome,
  type StepsRun,
  type StepType,
} from "./steps";
import type { TraceStepFormProps } from "./TraceStepForm";
import { TRACE_STEP_OUT, TRACE_STEP_TYPES } from "./traceSteps";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";
import { Icon } from "../components/Icon";
import { Checks, Choice, FieldChoice, NumberField, Text, withCurrent } from "./stepFields";
import { aggLabel, isTableFormStep, TableStepForm } from "./TableStepForms";

// The forms of the trace steps load with the texts of the trace screens, when a step is opened.
const TRACE_FORM = pieceSource<TraceStepFormProps>(() =>
  loadArea("traces")
    .then(() => import("./TraceStepForm"))
    .then((module) => ({ default: module.TraceStepForm })),
);

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
  /**
   * Compact cards, as in Explore: each step shows its number, name and what it does, and opens
   * for editing on a click; one "Add step" button opens the kinds of steps as a menu.
   */
  compact?: boolean | undefined;
  /**
   * Shows the property an algorithm step added on the canvas (a style rule: size or color by
   * value, a color per community); absent where the screen draws no graph.
   */
  onUseResult?: ((use: ResultUse, property: string, step: Step) => void) | undefined;
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

/**
 * The table steps in the catalog, by group in their order (Parity board, frame 14). Types this
 * version does not know yet are passed over, so a step that lands later finds its place.
 */
const CATALOG_ORDER: readonly (readonly [string, CatalogGroup])[] = [
  ["organize", "fields"],
  ["filterFields", "fields"],
  ["convert", "fields"],
  ["calculate", "fields"],
  ["filterRows", "rows"],
  ["sort", "rows"],
  ["limit", "rows"],
  ["join", "combine"],
  ["stack", "combine"],
  ["seriesToRows", "reshape"],
  ["pivot", "reshape"],
  ["group", "calculate"],
  ["reduceSeries", "calculate"],
  ["reduce", "calculate"],
  ["trend", "calculate"],
  ["movingAverage", "calculate"],
  ["correlate", "calculate"],
  ["compare", "calculate"],
];

/** Steps marked "new" in the catalog. */
const NEW_STEPS: readonly string[] = [
  "organize",
  "filterFields",
  "convert",
  "filterRows",
  "sort",
  "limit",
  "stack",
  "seriesToRows",
  "reduceSeries",
];

/**
 * Words that find a step besides its name and description, the same in both languages: the
 * common terms of the trade (decision 7: invisible, the names in the product stay Kalzit's).
 */
const GENERIC_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  calculate: ["formula", "expression", "add field"],
  organize: ["rename", "organize", "reorder", "alias"],
  filterFields: ["filter by name", "select columns", "regex"],
  convert: ["convert", "cast", "field type"],
  filterRows: ["filter by value", "where"],
  sort: ["sort by", "order by"],
  limit: ["limit", "top", "head"],
  join: ["join", "outer join"],
  stack: ["merge", "union", "append"],
  seriesToRows: ["series to rows", "unpivot", "melt"],
  pivot: ["pivot", "crosstab"],
  group: ["group by", "aggregate"],
  reduceSeries: ["reduce", "aggregate"],
  reduce: ["statistics", "percentile"],
  trend: ["regression", "linear"],
  movingAverage: ["rolling", "smooth"],
  correlate: ["correlation", "pearson"],
  compare: ["previous period", "time shift"],
};

/** Rows of each result the catalog's previews run on. */
const SAMPLE_ROWS = 50;

/** Graph steps that leave a graph. */
const GRAPH_TO_GRAPH: readonly StepType[] = ["topDegree", "degree", "filterGraph"];

/** The shape a step reads and the one it makes. */
function shapesOf(step: StepKind): [ShapeName, ShapeName] {
  if (isTraceStep(step)) return ["trace", TRACE_STEP_OUT[step.type]];
  if (isAlgoStep(step)) return ["graph", algoMakesTable(step) ? "frame" : "graph"];
  if (GRAPH_TO_GRAPH.includes(step.type)) return ["graph", "graph"];
  if (isGraphStep(step)) return ["graph", "frame"];
  if (step.type === "toFrame") return ["documents", "frame"];
  return ["frame", "frame"];
}

/** The step's name: a projection of a graph is "In Tabelle umwandeln". */
function kindLabel(t: Translate, step: StepKind): string {
  if (isAlgoStep(step)) {
    const variant = variantOf(step as unknown as { type: string } & Record<string, unknown>);
    return t(`analysis.kind.${variant?.key ?? step.type}` as MessageKey);
  }
  return step.type === "toFrame" && step.rows !== undefined
    ? t("analysis.kind.graphToFrame")
    : t(`analysis.kind.${step.type}`);
}

/** What a step does in a few words for its compact card: the fields it uses. */
export function stepSummary(t: Translate, step: StepKind): string {
  switch (step.type) {
    case "toFrame":
      return step.columns
        .map((column) => column.name ?? column.path)
        .filter((name) => name !== "")
        .join(", ");
    case "calculate":
      return `${step.name} = ${step.expression}`;
    case "reduce":
      return step.fields.join(", ");
    case "group": {
      const by = step.by.length === 0 ? "" : t("analysis.summary.by", { by: step.by.join(", ") });
      const aggs = step.aggregations
        .map((a) => (a.op === "count" ? aggLabel(t, a.op) : `${aggLabel(t, a.op)} ${a.field}`))
        .join(", ");
      return [by, aggs].filter((part) => part !== "").join(" · ");
    }
    case "pivot":
      return `${step.row} × ${step.column}`;
    case "correlate":
      return `${step.x}, ${step.y}`;
    case "sort":
      return step.by
        .map((k) =>
          k.desc === true ? t("analysis.sort.descSummary", { field: k.field }) : k.field,
        )
        .join(", ");
    case "trend":
    case "movingAverage":
    case "compare":
      return step.field;
    case "join":
      return `${step.left} + ${step.right}`;
    case "organize": {
      const renamed = Object.entries(step.rename ?? {}).map(([from, to]) => `${from} → ${to}`);
      const hidden = (step.hide ?? []).length;
      return [
        ...renamed,
        ...(hidden === 0 ? [] : [t("analysis.summary.hidden", { count: hidden })]),
      ].join(", ");
    }
    case "filterFields":
      return [...(step.names ?? []), ...(step.pattern === undefined ? [] : [step.pattern])].join(
        ", ",
      );
    case "filterRows":
      return step.conditions
        .map((c) =>
          [c.field, t(`analysis.rowOp.${c.op}`), c.value, c.to]
            .filter((x) => x !== undefined && x !== "")
            .join(" "),
        )
        .join(" · ");
    case "limit":
      return t(
        step.from === "last" ? "analysis.summary.limitLast" : "analysis.summary.limitFirst",
        {
          count: step.count,
        },
      );
    case "convert":
      return step.conversions
        .map((c) => `${c.field} → ${t(`analysis.convertTo.${c.to}`)}`)
        .join(", ");
    case "reduceSeries":
      return step.calculations.map((a) => aggLabel(t, a)).join(", ");
    case "stack":
    case "seriesToRows":
      return step.frames.join(" + ");
    case "spanTable":
      return (step.attributes ?? []).join(", ");
    case "filterSpans":
      return [...(step.services ?? []), ...(step.operations ?? [])].join(", ");
    case "paths":
      return step.from === "" || step.to === "" ? "" : `${step.from} → ${step.to}`;
    case "reachable":
      return step.from.join(", ");
    case "similarity":
      return (step.properties ?? []).join(", ");
    case "mergeNodes":
      return step.by === "property" ? (step.property ?? "") : t("analysis.algo.mergeBy.label");
    case "aggregateAlong":
      return step.name;
    default:
      return "";
  }
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
  compact = false,
  onUseResult,
}: StepsEditorProps) {
  const { t, language } = useI18n();
  // Compact cards open for editing one by one; a step just added opens at once.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const isOpen = (id: string) => !compact || opened.has(id);
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  // The step whose result the preview shows; -1 shows the queries' results.
  const [previewAt, setPreviewAt] = useState(-1);
  const [announcement, setAnnouncement] = useState({ text: "", count: 0 });
  // Each announcement is new to the live region, also when the words repeat (a step moved up
  // twice): the counter keys a fresh node, which screen readers read as an addition.
  const announce = (text: string) => setAnnouncement((a) => ({ text, count: a.count + 1 }));
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const frames = inputs.flatMap((i) => ("frame" in i ? [i] : []));
  const graphInputs = inputs.flatMap((i) => ("graph" in i ? [i] : []));
  const traceInputs = inputs.flatMap((i) => ("trace" in i ? [i] : []));
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
      target =
        root?.querySelector<HTMLElement>(".steps__add-button") ??
        root?.querySelector<HTMLElement>("button.select");
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

  // An algorithm step that finished says its sentence once in the live region (board, frame 20).
  const said = useRef(new Set<string>());
  const finished = run.steps
    .map((o) => {
      const step = steps.find((s) => s.id === o.id);
      const sentence = summarySentence(t, language, o.summary);
      return step === undefined || sentence === null
        ? null
        : {
            key: `${o.id}:${JSON.stringify(o.summary)}`,
            text: `${kindLabel(t, step)}: ${sentence}`,
          };
    })
    .filter((x): x is { key: string; text: string } => x !== null);
  const finishedKey = finished.map((f) => f.key).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: announces when the finished set changes
  useEffect(() => {
    const fresh = finished.filter((f) => !said.current.has(f.key));
    for (const f of fresh) said.current.add(f.key);
    if (fresh.length > 0) announce(fresh.map((f) => f.text).join(" "));
  }, [finishedKey]);

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
  /** The traces a step reads, as `inputOf` the frames. */
  const tracesOf = (index: number): readonly NamedTrace[] => {
    for (let i = index - 1; i >= 0; i--) {
      const out = outcomeAt(i)?.traces;
      if (out !== undefined) return out;
      if (outcomeAt(i)?.skipped !== true) return [];
    }
    return traceInputs;
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
    if (isAlgoStep(step)) {
      const variant = variantOf(step as unknown as { type: string } & Record<string, unknown>);
      return step.place !== "server" &&
        variant !== undefined &&
        plannedPlace(variant, kindOf(step.frame)) !== undefined
        ? "database"
        : "server";
    }
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
  // Trace steps while a trace is left; one the server has not answered yet may still make one.
  const tracesLeft = hasData ? run.traces.length > 0 : false;
  const tablesThere = !hasData || run.frames.length > 0 || frames.length > 0;
  const offered: StepType[] = [
    ...(tracesLeft ? TRACE_STEP_TYPES : []),
    ...(graphsLeft ? GRAPH_STEP_TYPES : []),
    ...(graphsLeft ? (["toFrame"] as const) : []),
    ...(tablesThere ? STEP_TYPES : []),
  ];
  function add(key: string) {
    const input = run.frames.length > 0 ? run.frames : frames;
    const variant = GRAPH_VARIANTS.find((v) => v.key === key);
    const type = (variant?.type ?? key) as StepType;
    const traceStep = (TRACE_STEP_TYPES as readonly string[]).includes(type);
    const target = run.graphs[0];
    const step: Step =
      variant !== undefined && isAlgoType(variant.type)
        ? ({
            id: crypto.randomUUID(),
            ...newAlgoStep(variant, target?.name ?? refIds[0] ?? "A", target?.graph),
          } as Step)
        : traceStep
          ? ({
              id: crypto.randomUUID(),
              type,
              frame: run.traces[0]?.name ?? refIds[0] ?? "A",
            } as Step)
          : newStep(type, refIds, input, t, run.graphs);
    onChange([...steps, step]);
    setOpened((current) => new Set([...current, step.id]));
  }
  /** The data source kind of the graph the steps read now, for where its steps compute. */
  const graphKind = kindOf(run.graphs[0]?.name ?? refIds[0] ?? "");
  /** One graph step of the catalog: an entry of the board's seven groups. */
  const graphEntryOf = (variant: GraphVariant): CatalogEntry => {
    const base = entryOf(variant.type as StepType);
    if (!isAlgoType(variant.type) && variant.type !== "degree") {
      return { ...base, key: variant.key, graphGroup: variant.group };
    }
    const library = plannedPlace(variant, graphKind);
    const help = `analysis.help.${variant.key}` as MessageKey;
    const words = `analysis.keywords.${variant.key}` as MessageKey;
    return {
      ...base,
      key: variant.key,
      label: t(`analysis.kind.${variant.key}` as MessageKey),
      about: t(`analysis.about.${variant.key}` as MessageKey),
      ...(hasMessage(help) ? { help: t(help) } : {}),
      keywords: hasMessage(words)
        ? t(words)
            .split(",")
            .map((w) => w.trim())
        : [],
      to: variant.table === true ? "frame" : "graph",
      graphGroup: variant.group,
      ...(variant.type === "degree" ? {} : { isNew: true }),
      where:
        library === undefined
          ? t("analysis.where.serverAlgo")
          : t("analysis.where.libraryOrServer", LIBRARY_NAMES[library]),
      whereShort:
        library === undefined ? t("analysis.where.server") : LIBRARY_NAMES[library].engine,
    };
  };
  /** One kind of step for the catalog, with its group, keywords and where it runs. */
  const entryOf = (type: StepType): CatalogEntry => {
    const graphStep = GRAPH_STEP_TYPES.includes(type as never) || type === "toFrame";
    const traceOut = TRACE_STEP_OUT[type as keyof typeof TRACE_STEP_OUT];
    const from: ShapeName = traceOut !== undefined ? "trace" : graphStep ? "graph" : "frame";
    const group = CATALOG_ORDER.find(([kind]) => kind === type)?.[1];
    const help = `analysis.help.${type}` as MessageKey;
    const words = `analysis.keywords.${type}` as MessageKey;
    const needsTwo = (type === "join" || type === "stack") && refIds.length < 2;
    return {
      key: type,
      type,
      label:
        type === "toFrame"
          ? t("analysis.kind.graphToFrame")
          : t(`analysis.kind.${type}` as MessageKey),
      about: t(`analysis.about.${type}` as MessageKey),
      ...(hasMessage(help) ? { help: t(help) } : {}),
      keywords: [
        ...(hasMessage(words)
          ? t(words)
              .split(",")
              .map((w) => w.trim())
          : []),
        ...(GENERIC_KEYWORDS[type] ?? []),
      ],
      from,
      to: traceOut ?? (GRAPH_TO_GRAPH.includes(type) ? "graph" : "frame"),
      ...(group === undefined ? {} : { group }),
      ...(NEW_STEPS.includes(type) ? { isNew: true } : {}),
      where: from === "frame" ? t("analysis.where.browser") : t("analysis.where.server"),
      ...(needsTwo
        ? { unavailable: t("analysis.catalog.needsTwo") }
        : from === "frame" && !tablesThere
          ? { unavailable: t("analysis.catalog.tablesLater") }
          : {}),
    };
  };
  const tableOrder = CATALOG_ORDER.map(([kind]) => kind).filter((kind) =>
    (STEP_TYPES as readonly string[]).includes(kind),
  ) as StepType[];
  const catalog: CatalogEntry[] = [
    ...(tracesLeft ? TRACE_STEP_TYPES : []).map(entryOf),
    ...(graphsLeft ? GRAPH_VARIANTS : []).map(graphEntryOf),
    ...tableOrder.map(entryOf),
  ];
  const catalogShapes: ShapeName[] = [
    ...(tablesThere || (!graphsLeft && !tracesLeft) ? (["frame"] as const) : []),
    ...(graphsLeft ? (["graph"] as const) : []),
    ...(tracesLeft ? (["trace"] as const) : []),
    ...(!tablesThere && (graphsLeft || tracesLeft) ? (["frame"] as const) : []),
  ];
  const tablesNow = run.frames.length > 0 ? run.frames : frames;
  const sampleOf = (nf: NamedFrame): NamedFrame => ({
    name: nf.name,
    frame: {
      ...nf.frame,
      fields: nf.frame.fields.map((f) => ({ ...f, values: f.values.slice(0, SAMPLE_ROWS) })),
    },
  });
  const sampleFrames = tablesNow.map(sampleOf);
  const firstFrame = tablesNow[0]?.frame;
  const before: BeforeStep = !hasData
    ? { kind: "none" }
    : firstFrame !== undefined
      ? {
          kind: "frame",
          rows: firstFrame.fields[0]?.values.length ?? 0,
          fields: firstFrame.fields.length,
        }
      : run.graphs[0] !== undefined
        ? {
            kind: "graph",
            nodes: run.graphs[0].graph.nodes.length,
            edges: run.graphs[0].graph.edges.length,
          }
        : run.traces[0] !== undefined
          ? { kind: "trace", count: run.traces[0].trace.spans.length }
          : { kind: "none" };
  /** A new step of `type` with its defaults, run on the first rows of the person's tables. */
  const previewOf = (key: string): StepPreview => {
    const type = (GRAPH_VARIANTS.find((v) => v.key === key)?.type ?? key) as StepType;
    if (!hasData || sampleFrames.length === 0) {
      return GRAPH_STEP_TYPES.includes(type as never) ||
        (TRACE_STEP_TYPES as readonly string[]).includes(type) ||
        type === "toFrame"
        ? { kind: "later" }
        : { kind: "noData" };
    }
    if (!(STEP_TYPES as readonly string[]).includes(type)) return { kind: "later" };
    const step = newStep(type, refIds, sampleFrames, t);
    const out = runSteps([step], sampleFrames, { calendar });
    if (out.failed !== undefined) {
      const e = out.failed.error;
      return {
        kind: "error",
        reason:
          reasonText(t, { reason: e.reason, params: e.params, fallback: e.message }) ?? e.message,
      };
    }
    const frame = out.frames.find((f) => f.name === stepTarget(step))?.frame;
    return frame === undefined ? { kind: "noData" } : { kind: "frame", frame };
  };

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
          } else if (outcome?.waiting === true) {
            status = isAlgoStep(step) ? t("analysis.algo.running") : t("analysis.chain.unknown");
          } else if (outcome?.traces?.some((x) => stepTarget(step) === x.name) === true) {
            status = t("analysis.chain.spans", {
              count:
                outcome.traces.find((x) => stepTarget(step) === x.name)?.trace.spans.length ?? 0,
            });
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
          const where = isTraceStep(step)
            ? t("analysis.where.server")
            : isAlgoStep(step)
              ? placeBadge(t, placeOf(index), kindOf(stepTarget(step)))
              : isGraphStep(step)
                ? placeOf(index) === "database"
                  ? t("analysis.where.database", {
                      engine: PUSHDOWN_KINDS[kindOf(stepTarget(step)) ?? ""] ?? "",
                    })
                  : t("analysis.where.server")
                : t("analysis.where.browser");
          const open = isOpen(step.id);
          const summary = stepSummary(t, step);
          return (
            <li
              key={step.id}
              className="step"
              aria-label={t("analysis.steps.number", { n })}
              data-step={step.id}
              data-compact={compact ? "true" : undefined}
            >
              {compact ? (
                <button
                  type="button"
                  className="step__toggle"
                  aria-expanded={open}
                  onClick={() => toggle(step.id)}
                >
                  <span className="step__title">
                    {t("analysis.steps.cardTitle", { n, name: kindLabel(t, step) })}
                  </span>
                  {/* Without fields to name, a closed card shows the step's status instead; an
                      open card shows that status under its form, so the head does not repeat it. */}
                  {open && summary === "" ? null : (
                    <span className="step__summary">
                      {open ? summary : step.disabled === true || summary === "" ? status : summary}
                    </span>
                  )}
                </button>
              ) : null}
              {open ? (
                <>
                  <div className="step__header">
                    {compact ? null : (
                      <>
                        <span className="step__number">{n}</span>
                        <span className="step__title">{kindLabel(t, step)}</span>
                      </>
                    )}
                    <ShapeChip from={shapesOf(step)[0]} to={shapesOf(step)[1]} />
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={step.disabled !== true}
                        onChange={(event) => {
                          const { disabled: _, ...rest } = step;
                          update(
                            index,
                            event.currentTarget.checked
                              ? (rest as Step)
                              : { ...step, disabled: true },
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
                        <Icon name="arrowUp" />
                      </button>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("analysis.steps.down", { n })}
                        data-action="down"
                        disabled={index === steps.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <Icon name="arrowDown" />
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
                    traces={tracesOf(index)}
                  />
                  <p className="step__status">{status}</p>
                  {isAlgoStep(step) && step.disabled !== true ? (
                    <AlgoOutcome
                      step={step}
                      outcome={outcome}
                      onServer={() => update(index, { ...step, place: "server" })}
                      onFilterBefore={() => {
                        const filter: Step = {
                          id: crypto.randomUUID(),
                          type: "filterGraph",
                          frame: step.frame,
                        };
                        onChange([...steps.slice(0, index), filter, ...steps.slice(index)]);
                        setOpened((current) => new Set([...current, filter.id]));
                      }}
                      onUse={
                        onUseResult === undefined
                          ? undefined
                          : (use, property) => onUseResult(use, property, step)
                      }
                    />
                  ) : null}
                  {/* A service map or span tree over very many spans asks before it runs. */}
                  {outcome?.error?.reason === "steps.trace_graph_large" &&
                  (step.type === "serviceMap" || step.type === "spanTree") ? (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => update(index, { ...step, confirmLarge: true })}
                    >
                      {t("analysis.steps.confirmLarge")}
                    </button>
                  ) : null}
                  <p className="step__where">
                    {from === to ? where : t("analysis.where.changes", { where })}
                  </p>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
      {steps.some(isGraphStep) ? (
        <ShapeChain steps={steps} graphs={graphInputs} outcomeOf={(id) => byId.get(id)} />
      ) : null}
      {steps.length < MAX_STEPS && offered.length > 0 ? (
        <StepCatalog
          entries={catalog}
          shapes={catalogShapes}
          before={before}
          sample={sampleFrames[0]?.frame}
          previewOf={previewOf}
          onAdd={add}
        />
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
  if (step.type === "join") return step.left;
  if (step.type === "stack" || step.type === "seriesToRows") return step.frames[0] ?? "";
  return step.frame;
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
    case "organize":
      return { id, type, frame };
    case "filterFields":
      return fields.length === 0
        ? { id, type, frame, mode: "keep", pattern: "." }
        : { id, type, frame, mode: "keep", names: fields.map((f) => f.name) };
    case "filterRows":
      return {
        id,
        type,
        frame,
        mode: "keep",
        match: "all",
        conditions: [{ field: firstNumber || (fields[0]?.name ?? ""), op: "notEmpty" }],
      };
    case "limit":
      return { id, type, frame, count: 10 };
    case "convert":
      return {
        id,
        type,
        frame,
        conversions: [
          {
            field: fields.find((f) => f.type === "string")?.name ?? fields[0]?.name ?? "",
            to: "number",
          },
        ],
      };
    case "reduceSeries":
      return { id, type, frame, mode: "rows", calculations: ["last", "mean", "max"] };
    case "stack":
      return { id, type, frames: refIds.length > 1 ? [...refIds] : [frame] };
    case "seriesToRows":
      return { id, type, frames: [frame] };
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
    case "sort":
      return { id, type, frame, by: [{ field: fields[0]?.name ?? "" }] };
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
  /** The traces the step reads. */
  traces: readonly NamedTrace[];
}

function StepForm({ step, onChange, refIds, input, graphs, traces }: FormProps) {
  const { t } = useI18n();
  const fieldsOf = (name: string) => input.find((f) => f.name === name)?.frame.fields ?? [];
  // Each kind's own fields; the shared frame choice comes first.
  const set = <K extends StepKind>(patch: Partial<K>) => onChange({ ...step, ...patch } as Step);
  const frameChoice =
    step.type === "join" || step.type === "stack" || step.type === "seriesToRows" ? null : (
      <Choice
        label={t("analysis.field.frame")}
        value={step.frame}
        options={refIds.map((r) => [r, r])}
        onChange={(frame) => set({ frame })}
        hidden={refIds.length < 2}
      />
    );
  if (isTableFormStep(step)) {
    return (
      <TableStepForm
        step={step}
        onChange={onChange}
        refIds={refIds}
        input={input}
        frameChoice={frameChoice}
      />
    );
  }
  if (isTraceStep(step)) {
    const trace = traces.find((x) => x.name === step.frame)?.trace;
    return <LazyPiece source={TRACE_FORM} props={{ step, trace, frameChoice, onChange }} />;
  }
  if (isAlgoStep(step)) {
    const graph = graphs.find((g) => g.name === step.frame)?.graph;
    return (
      <AlgoStepForm
        step={step as AlgoStepKind & { id: string }}
        graph={graph}
        frameChoice={frameChoice}
        onChange={(next) => onChange(next as Step)}
      />
    );
  }
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
    case "sort":
      return (
        <SortForm
          step={step}
          fields={fieldsOf(step.frame)}
          frameChoice={frameChoice}
          onChange={(by) => onChange({ ...step, by })}
        />
      );
    default:
      return null;
  }
}

/** Without `key` when `value` is empty: optional fields are left out, not stored empty. */
export function optional<S extends Step>(step: S, key: string, value: string): S {
  const { [key]: _, ...rest } = step as Record<string, unknown>;
  return (value === "" ? rest : { ...rest, [key]: value }) as S;
}

const DIRECTIONS: readonly Direction[] = ["both", "out", "in"];

/** Without `key` when the list is empty. */
export function optionalList<S extends Step>(step: S, key: string, value: string[]): S {
  const { [key]: _, ...rest } = step as Record<string, unknown>;
  return (value.length === 0 ? rest : { ...rest, [key]: value }) as S;
}

/** The value of a condition as typed: a number for comparisons, else text ("true" and "false" as such). */
export function valueFor(op: PropertyOp, text: string): { value?: string | number | boolean } {
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

export function keptValue(filter: PropertyFilter | undefined): {
  value?: string | number | boolean;
} {
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

/** The keys of a sort step: a field and a direction each, up to `MAX_SORT_KEYS`. */
function SortForm({
  step,
  fields,
  frameChoice,
  onChange,
}: {
  step: Extract<Step, { type: "sort" }>;
  fields: readonly Field[];
  frameChoice: ReactNode;
  onChange: (by: SortKey[]) => void;
}) {
  const { t } = useI18n();
  const legendId = useId();
  const keys = fields.filter((f) => f.type !== "json");
  const setKey = (index: number, key: SortKey) =>
    onChange(step.by.map((k, i) => (i === index ? key : k)));
  return (
    <div className="step__form">
      {frameChoice}
      <fieldset className="step__aggregations" aria-labelledby={legendId}>
        <span className="field__label" id={legendId}>
          {t("analysis.field.sortBy")}
        </span>
        {step.by.map((k, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: keys are edited in place by position
          <div className="step__aggregation" key={i}>
            <FieldChoice
              label={t("analysis.field.field")}
              value={k.field}
              fields={keys}
              onChange={(field) => setKey(i, k.desc === true ? { field, desc: true } : { field })}
            />
            <Choice
              label={t("analysis.field.direction")}
              value={k.desc === true ? "desc" : "asc"}
              options={[
                ["asc", t("analysis.sort.asc")],
                ["desc", t("analysis.sort.desc")],
              ]}
              onChange={(dir) =>
                setKey(i, dir === "desc" ? { field: k.field, desc: true } : { field: k.field })
              }
            />
            {step.by.length > 1 ? (
              <button
                type="button"
                className="button button--ghost button--small"
                aria-label={t("analysis.sort.remove", { n: i + 1 })}
                onClick={() => onChange(step.by.filter((_, j) => j !== i))}
              >
                {t("analysis.steps.remove")}
              </button>
            ) : null}
          </div>
        ))}
        {step.by.length < MAX_SORT_KEYS ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onChange([...step.by, { field: keys[0]?.name ?? "" }])}
          >
            {t("analysis.sort.add")}
          </button>
        ) : null}
      </fieldset>
    </div>
  );
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

export { Checks, Choice, Text };

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
