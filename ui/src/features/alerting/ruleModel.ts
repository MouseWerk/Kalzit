import type { MessageKey, Translate } from "../../i18n/i18n";
import { familyOf } from "../datasources/queryKinds";
import type {
  AlertState,
  Comparison,
  Condition,
  ConditionOp,
  ErrorState,
  FieldFunction,
  FrameFunction,
  GraphCount,
  HistoryEntry,
  NoDataState,
  Reduce,
  Rule,
  RuleInput,
  RuleRouting,
  Silence,
} from "./api";
import { isRange } from "./api";

/**
 * The rule editor's working copy and the rules it follows (docs/api/alerting.md, "Rules"): what
 * the form holds, how it turns into the request body, and the checks the server makes too, so a
 * mistake shows at its field before saving.
 */

export type Shape = "frame" | "documents" | "graph";

export interface LabelRow {
  key: string;
  value: string;
}

export interface RuleDraft {
  name: string;
  description: string;
  runbookUrl: string;
  datasourceId: string;
  query: unknown;
  steps: unknown[];
  variables: Record<string, unknown>;
  rangeSecs: number;
  shape: Shape;
  frameFunction: FrameFunction;
  documentsMode: "count" | "field";
  documentsPath: string;
  documentsFunction: FieldFunction;
  graphCount: GraphCount;
  graphLabel: string;
  op: ConditionOp;
  /** Typed numbers, as text: the field keeps what is typed until it is a number. */
  value: string;
  low: string;
  high: string;
  intervalSecs: number;
  forSecs: number;
  noDataState: NoDataState;
  errorState: ErrorState;
  labels: LabelRow[];
  reminderSecs: number;
  /** Through the policies or directly to the contact points; a server without policies: direct. */
  routing: RuleRouting;
  contactPointIds: string[];
  dashboardId: string | null;
  panelId: string | null;
}

export const MAX_LABELS = 20;
export const MAX_LABEL_VALUE = 256;
export const MAX_NAME = 200;
export const MAX_FOR_SECS = 86_400;
export const MAX_INTERVAL_SECS = 86_400;

/** Choices offered in the editor; the server takes any value within the bounds. */
export const INTERVAL_CHOICES = [30, 60, 120, 300, 600, 900, 1800, 3600, 21_600, 86_400] as const;
export const FOR_CHOICES = [0, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 43_200, 86_400];
export const RANGE_CHOICES = [300, 600, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400] as const;
export const REMINDER_CHOICES = [0, 3600, 14_400, 43_200, 86_400] as const;

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    description: "",
    runbookUrl: "",
    datasourceId: "",
    query: undefined,
    steps: [],
    variables: {},
    rangeSecs: 600,
    shape: "frame",
    frameFunction: "last",
    documentsMode: "count",
    documentsPath: "",
    documentsFunction: "max",
    graphCount: "nodes",
    graphLabel: "",
    op: "gt",
    value: "",
    low: "",
    high: "",
    intervalSecs: 60,
    forSecs: 0,
    noDataState: "no_data",
    errorState: "error",
    labels: [],
    reminderSecs: 14_400,
    routing: "policies",
    contactPointIds: [],
    dashboardId: null,
    panelId: null,
  };
}

const numberText = (value: number) => String(value);

/** The draft of a stored rule. */
export function draftFromRule(rule: Rule): RuleDraft {
  const draft: RuleDraft = {
    ...emptyDraft(),
    name: rule.name,
    description: rule.description,
    runbookUrl: rule.runbookUrl ?? "",
    datasourceId: rule.datasourceId,
    query: rule.query?.query,
    steps: rule.query?.steps ?? [],
    variables: rule.query?.variables ?? {},
    rangeSecs: rule.rangeSecs,
    intervalSecs: rule.intervalSecs,
    forSecs: rule.forSecs,
    noDataState: rule.noDataState,
    errorState: rule.errorState,
    labels: Object.entries(rule.labels).map(([key, value]) => ({ key, value })),
    reminderSecs: rule.reminderSecs,
    routing: rule.routing ?? (rule.contactPointIds.length > 0 ? "direct" : "policies"),
    contactPointIds: [...rule.contactPointIds],
    dashboardId: rule.dashboardId,
    panelId: rule.panelId,
    op: rule.condition.op,
  };
  const reduce = rule.reduce;
  draft.shape = reduce.shape;
  if (reduce.shape === "frame") {
    draft.frameFunction = reduce.function;
  } else if (reduce.shape === "documents") {
    draft.documentsMode = reduce.mode;
    if (reduce.mode === "field") {
      draft.documentsPath = reduce.path;
      draft.documentsFunction = reduce.function;
    }
  } else {
    draft.graphCount = reduce.count;
    draft.graphLabel = reduce.label ?? "";
  }
  const condition = rule.condition;
  if (isRange(condition)) {
    draft.low = numberText(condition.low);
    draft.high = numberText(condition.high);
  } else {
    draft.value = numberText(condition.value);
  }
  return draft;
}

/** The shape a source's results usually have: documents and graphs from their databases. */
export function shapeForKind(kind: string): Shape {
  switch (familyOf(kind)) {
    case "mongo":
      return "documents";
    case "cypher":
    case "gsql":
      return "graph";
    default:
      return "frame";
  }
}

const UNIT_SECS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
const MAX_RANGE_SECS = 30 * 86_400;

/** A relative range as dashboards write it ("now-6h") in seconds; 10 minutes otherwise. */
export function rangeSecsOf(from: string): number {
  const match = /^now-(\d+)([smhdw])$/.exec(from.trim());
  if (match === null) return 600;
  const secs = Number(match[1]) * (UNIT_SECS[match[2] ?? "m"] ?? 60);
  return Math.min(Math.max(secs, 1), MAX_RANGE_SECS);
}

/** What a rule copies from a panel: its first shown query, the dashboard's values and range. */
export interface PanelSource {
  dashboardId: string;
  panelId: string;
  title: string;
  dashboardTitle: string;
  timeFrom: string;
  target: { datasourceId: string; query: unknown } | undefined;
  variables: readonly { name: string; type: string; current?: unknown }[];
}

/** The query of a panel as a rule keeps it: a copy, with the variables fixed to their values. */
export function panelQuery(
  source: PanelSource,
): Pick<RuleDraft, "datasourceId" | "query" | "variables"> {
  const variables: Record<string, unknown> = {};
  for (const variable of source.variables) {
    if (variable.type === "constant") continue;
    const current = variable.current;
    if (
      typeof current === "string" ||
      (Array.isArray(current) && current.every((v) => typeof v === "string"))
    ) {
      variables[variable.name] = current;
    } else if (isValueRecord(current)) {
      variables[variable.name] = current.value;
    }
  }
  return {
    datasourceId: source.target?.datasourceId ?? "",
    query: source.target?.query,
    variables,
  };
}

function isValueRecord(value: unknown): value is { value: string | string[] } {
  if (typeof value !== "object" || value === null || !("value" in value)) return false;
  const inner = (value as { value: unknown }).value;
  return (
    typeof inner === "string" || (Array.isArray(inner) && inner.every((v) => typeof v === "string"))
  );
}

/** A new rule from a panel ("Alert-Regel erstellen" in the panel menu). */
export function draftFromPanel(source: PanelSource): RuleDraft {
  return {
    ...emptyDraft(),
    ...panelQuery(source),
    name: source.title,
    rangeSecs: rangeSecsOf(source.timeFrom),
    dashboardId: source.dashboardId,
    panelId: source.panelId,
  };
}

/** Whether the panel's query differs from the rule's copy, so "Abfrage übernehmen" is offered. */
export function panelChanged(draft: RuleDraft, source: PanelSource): boolean {
  const copy = panelQuery(source);
  return (
    copy.datasourceId !== "" &&
    (copy.datasourceId !== draft.datasourceId ||
      JSON.stringify(copy.query) !== JSON.stringify(draft.query))
  );
}

/** The fields an error can be shown at, in the order of the form. */
export type DraftField =
  | "name"
  | "datasourceId"
  | "query"
  | "documentsPath"
  | "graphLabel"
  | "value"
  | "low"
  | "high"
  | "intervalSecs"
  | "forSecs"
  | "labels"
  | "contactPointIds"
  | "runbookUrl";

export type DraftErrors = Partial<
  Record<DraftField, { key: MessageKey; params?: Record<string, string | number> }>
>;

const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_-]*(\[\d+\])*)+$/;

/** A number as people type it: a comma or a point for decimals. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Whether a label name may be used in a rule (and in a silence's condition). */
export function labelNameValid(name: string): boolean {
  return LABEL_NAME.test(name) && name !== "alertname" && !name.startsWith("__");
}

export function pathValid(path: string): boolean {
  return PATH.test(path.trim());
}

function runbookValid(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

function queryEmpty(query: unknown): boolean {
  if (query === undefined || query === null) return true;
  if (typeof query === "string") return query.trim() === "";
  if (typeof query === "object") {
    return Object.values(query as Record<string, unknown>).every(
      (part) =>
        part === undefined || part === null || (typeof part === "string" && part.trim() === ""),
    );
  }
  return false;
}

export interface Bounds {
  minIntervalSecs: number;
  maxContactPointsPerRule: number;
}

/** The problems of a draft, per field; empty when it can be saved. */
export function validateDraft(draft: RuleDraft, bounds: Bounds): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.name.trim() === "") {
    errors.name = { key: "alerting.editor.error.nameRequired" };
  }
  if (draft.datasourceId === "") {
    errors.datasourceId = { key: "alerting.editor.error.sourceRequired" };
  } else if (queryEmpty(draft.query)) {
    errors.query = { key: "alerting.editor.error.queryRequired" };
  }
  if (
    draft.shape === "documents" &&
    draft.documentsMode === "field" &&
    !pathValid(draft.documentsPath)
  ) {
    errors.documentsPath = { key: "alerting.reason.alerts.reduce_path_invalid" };
  }
  if (draft.shape === "graph" && draft.graphCount === "paths" && draft.graphLabel.trim() !== "") {
    errors.graphLabel = { key: "alerting.editor.error.pathsNoLabel" };
  }
  if (draft.op === "outside" || draft.op === "inside") {
    const low = parseNumber(draft.low);
    const high = parseNumber(draft.high);
    if (low === null) errors.low = { key: "alerting.editor.error.number" };
    if (high === null) errors.high = { key: "alerting.editor.error.number" };
    if (low !== null && high !== null && !(low < high)) {
      errors.high = { key: "alerting.editor.error.lowBelowHigh" };
    }
  } else if (parseNumber(draft.value) === null) {
    errors.value = { key: "alerting.editor.error.number" };
  }
  if (draft.intervalSecs < bounds.minIntervalSecs || draft.intervalSecs > MAX_INTERVAL_SECS) {
    errors.intervalSecs = {
      key: "alerting.editor.error.interval",
      params: { min: bounds.minIntervalSecs },
    };
  }
  if (
    draft.forSecs < 0 ||
    draft.forSecs > MAX_FOR_SECS ||
    draft.forSecs % draft.intervalSecs !== 0
  ) {
    errors.forSecs = { key: "alerting.editor.error.forMultiple" };
  }
  const labelProblem = labelsProblem(draft.labels);
  if (labelProblem !== null) {
    errors.labels = labelProblem;
  }
  if (draft.contactPointIds.length > bounds.maxContactPointsPerRule) {
    errors.contactPointIds = {
      key: "alerting.reason.alerts.too_many_contact_points",
      params: { max: bounds.maxContactPointsPerRule },
    };
  }
  if (draft.runbookUrl.trim() !== "" && !runbookValid(draft.runbookUrl.trim())) {
    errors.runbookUrl = { key: "alerting.reason.alerts.runbook_url_invalid" };
  }
  return errors;
}

function labelsProblem(rows: readonly LabelRow[]): NonNullable<DraftErrors["labels"]> | null {
  const filled = rows.filter((row) => row.key.trim() !== "" || row.value.trim() !== "");
  if (filled.length > MAX_LABELS) {
    return { key: "alerting.editor.error.tooManyLabels", params: { max: MAX_LABELS } };
  }
  const seen = new Set<string>();
  for (const row of filled) {
    const key = row.key.trim();
    if (!labelNameValid(key)) {
      return { key: "alerting.editor.error.labelName", params: { name: key } };
    }
    if (seen.has(key)) {
      return { key: "alerting.editor.error.labelTwice", params: { name: key } };
    }
    seen.add(key);
    if (row.value === "" || row.value.length > MAX_LABEL_VALUE) {
      return {
        key: "alerting.editor.error.labelValue",
        params: { name: key, max: MAX_LABEL_VALUE },
      };
    }
  }
  return null;
}

export function reduceOf(draft: RuleDraft): Reduce {
  if (draft.shape === "frame") {
    return { shape: "frame", function: draft.frameFunction };
  }
  if (draft.shape === "documents") {
    return draft.documentsMode === "count"
      ? { shape: "documents", mode: "count" }
      : {
          shape: "documents",
          mode: "field",
          path: draft.documentsPath.trim(),
          function: draft.documentsFunction,
        };
  }
  const label = draft.graphLabel.trim();
  return label === "" || draft.graphCount === "paths"
    ? { shape: "graph", count: draft.graphCount }
    : { shape: "graph", count: draft.graphCount, label };
}

/** The condition of a draft; numbers that do not parse count as 0 (validation stops those). */
export function conditionOf(draft: RuleDraft): Condition {
  if (draft.op === "outside" || draft.op === "inside") {
    return { op: draft.op, low: parseNumber(draft.low) ?? 0, high: parseNumber(draft.high) ?? 0 };
  }
  return { op: draft.op, value: parseNumber(draft.value) ?? 0 };
}

/** The request body of a draft (`POST`/`PUT` without `version`). */
/**
 * The request body of a rule. With `routing` (a server that has policies) it says how the rule
 * is routed, and only a direct rule names contact points; without, it is the body of 0.7.0.
 */
export function inputOf(draft: RuleDraft, routing = false): RuleInput {
  const direct = !routing || draft.routing === "direct";
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    runbookUrl: draft.runbookUrl.trim() === "" ? null : draft.runbookUrl.trim(),
    datasourceId: draft.datasourceId,
    query: { query: draft.query ?? null, steps: draft.steps, variables: draft.variables },
    rangeSecs: draft.rangeSecs,
    reduce: reduceOf(draft),
    condition: conditionOf(draft),
    intervalSecs: draft.intervalSecs,
    forSecs: draft.forSecs,
    noDataState: draft.noDataState,
    errorState: draft.errorState,
    labels: Object.fromEntries(
      draft.labels
        .filter((row) => row.key.trim() !== "")
        .map((row) => [row.key.trim(), row.value] as const),
    ),
    reminderSecs: draft.reminderSecs,
    ...(routing ? { routing: draft.routing } : {}),
    contactPointIds: direct ? draft.contactPointIds : [],
    dashboardId: draft.dashboardId,
    panelId: draft.dashboardId === null ? null : draft.panelId,
  };
}

/** Changing the interval keeps the for-duration a multiple of it (rounded up). */
export function withInterval(draft: RuleDraft, intervalSecs: number): RuleDraft {
  const forSecs =
    draft.forSecs === 0
      ? 0
      : Math.min(Math.ceil(draft.forSecs / intervalSecs) * intervalSecs, MAX_FOR_SECS);
  return { ...draft, intervalSecs, forSecs };
}

/** The for-durations that fit an interval: 0 and its multiples among the usual choices. */
export function forChoices(intervalSecs: number, current: number): number[] {
  const fitting = FOR_CHOICES.filter((secs) => secs % intervalSecs === 0 && secs <= MAX_FOR_SECS);
  return fitting.includes(current) ? fitting : [...fitting, current].sort((a, b) => a - b);
}

export function intervalChoices(minIntervalSecs: number, current: number): number[] {
  const fitting = INTERVAL_CHOICES.filter((secs) => secs >= minIntervalSecs);
  return fitting.includes(current as (typeof INTERVAL_CHOICES)[number])
    ? fitting
    : [...fitting, current].sort((a, b) => a - b);
}

// ---- texts ------------------------------------------------------------------------------------

const SYMBOLS: Record<Comparison, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  ne: "≠",
};

export function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(value);
}

/** "> 1,5", "außerhalb von 10 bis 20". */
export function conditionText(t: Translate, condition: Condition, language: string): string {
  if (isRange(condition)) {
    return t(
      condition.op === "outside"
        ? "alerting.condition.outsideText"
        : "alerting.condition.insideText",
      {
        low: formatNumber(condition.low, language),
        high: formatNumber(condition.high, language),
      },
    );
  }
  return `${SYMBOLS[condition.op]} ${formatNumber(condition.value, language)}`;
}

/** "max je Serie", "Anzahl Dokumente", "max von $.queue.depth", "Anzahl Pfade". */
export function reduceText(t: Translate, reduce: Reduce): string {
  if (reduce.shape === "frame") {
    return t("alerting.reduce.frameText", { fn: reduce.function });
  }
  if (reduce.shape === "documents") {
    return reduce.mode === "count"
      ? t("alerting.reduce.documentsCount")
      : t("alerting.reduce.fieldText", { fn: reduce.function, path: reduce.path });
  }
  const what = t(`alerting.reduce.graph.${reduce.count}`);
  return reduce.label === undefined || reduce.label === ""
    ? t("alerting.reduce.graphText", { what })
    : t("alerting.reduce.graphLabelText", { what, label: reduce.label });
}

/** A duration in the largest whole unit: "30 Sekunden", "5 Minuten", "4 Stunden", "1 Tag". */
export function durationText(t: Translate, secs: number): string {
  const units: [number, MessageKey, MessageKey][] = [
    [86_400, "alerting.duration.day", "alerting.duration.days"],
    [3600, "alerting.duration.hour", "alerting.duration.hours"],
    [60, "alerting.duration.minute", "alerting.duration.minutes"],
  ];
  for (const [size, one, many] of units) {
    if (secs >= size && secs % size === 0) {
      const count = secs / size;
      return count === 1 ? t(one) : t(many, { count });
    }
  }
  return secs === 1
    ? t("alerting.duration.second")
    : t("alerting.duration.seconds", { count: secs });
}

/** "1 min · für 5 min", "1 min · sofort". */
export function scheduleText(t: Translate, intervalSecs: number, forSecs: number): string {
  return forSecs === 0
    ? t("alerting.rules.scheduleNow", { interval: durationText(t, intervalSecs) })
    : t("alerting.rules.scheduleFor", {
        interval: durationText(t, intervalSecs),
        for: durationText(t, forSecs),
      });
}

/** Most severe first: the order of the list and of an instance count. */
export const STATE_ORDER: readonly AlertState[] = ["firing", "error", "no_data", "pending", "ok"];

export function stateRank(state: AlertState | null, paused: boolean): number {
  if (paused) return STATE_ORDER.length + 1;
  return state === null ? STATE_ORDER.length : STATE_ORDER.indexOf(state);
}

/** Rules by state (most severe first, paused last), then by name. */
export function sortRules<T extends Pick<Rule, "state" | "paused" | "name">>(
  rules: readonly T[],
): T[] {
  return [...rules].sort(
    (a, b) =>
      stateRank(a.state, a.paused) - stateRank(b.state, b.paused) || a.name.localeCompare(b.name),
  );
}

/** Label pairs as "key=value", sorted by name. */
export function labelPairs(labels: Readonly<Record<string, string>>): string[] {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key] ?? ""}`);
}

export interface Segment {
  state: AlertState;
  from: number;
  to: number;
}

/** The states of each instance over the range, from its changes, oldest first. */
export function timelineRows(
  entries: readonly HistoryEntry[],
  from: number,
  to: number,
): { key: string; title: string; segments: Segment[] }[] {
  const byInstance = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== "transition" || entry.toState === null) continue;
    const key = `${entry.ruleId}:${entry.fingerprint ?? ""}`;
    const list = byInstance.get(key) ?? [];
    list.push(entry);
    byInstance.set(key, list);
  }
  return [...byInstance.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const first = sorted[0] as HistoryEntry;
    const segments: Segment[] = [];
    let state: AlertState = first.fromState ?? "ok";
    let at = from;
    for (const entry of sorted) {
      const time = Math.max(from, Math.min(to, entry.at));
      if (time > at) segments.push({ state, from: at, to: time });
      state = entry.toState as AlertState;
      at = time;
    }
    if (to > at) segments.push({ state, from: at, to });
    const pairs = labelPairs(first.labels);
    const instance =
      pairs.length === 0
        ? ""
        : ` · ${pairs.map((pair) => pair.split("=").slice(1).join("=")).join(", ")}`;
    return { key, title: `${first.ruleName}${instance}`, segments };
  });
}

/** Whether a silence's conditions all match an instance (its labels and the rule's name). */
export function silenceMatches(
  matchers: readonly { label: string; op: string; value: string }[],
  labels: Readonly<Record<string, string>>,
): boolean {
  return matchers.every((matcher) => {
    const value = labels[matcher.label] ?? "";
    if (matcher.op === "=") return value === matcher.value;
    if (matcher.op === "!=") return value !== matcher.value;
    try {
      return new RegExp(`^(?:${matcher.value})$`).test(value);
    } catch {
      return false;
    }
  });
}

/** When the first active silence that holds back this instance ends; null when none does. */
export function silenceEnd(
  silences: readonly Pick<Silence, "matchers" | "endsAt" | "status">[],
  ruleName: string,
  labels: Readonly<Record<string, string>>,
): number | null {
  const all = { ...labels, alertname: ruleName };
  const ends = silences
    .filter((silence) => silence.status === "active" && silenceMatches(silence.matchers, all))
    .map((silence) => silence.endsAt);
  return ends.length === 0 ? null : Math.min(...ends);
}
