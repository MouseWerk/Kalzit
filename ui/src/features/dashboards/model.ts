import { isRecord } from "../../api/client";
import { WEEK_STARTS, type WeekStart } from "../../lib/timeSettings";

/**
 * The dashboard model (docs/ARCHITECTURE.md, "Dashboards"; version 2 parts in
 * docs/api/dashboard-features.md). The server migrates older models on read; the UI still parses
 * defensively, so one odd panel cannot break the page.
 */

/** The model version this UI writes; the server stores and answers the same. */
export const SCHEMA_VERSION = 2;

/** Columns of the dashboard grid. */
export const GRID_COLUMNS = 24;
export const MIN_PANEL_WIDTH = 2;
export const MIN_PANEL_HEIGHT = 2;
/** The server's limits on a panel's height and row (docs/api/settings-dashboards.md). */
export const MAX_PANEL_HEIGHT = 200;
export const MAX_GRID_Y = 10_000;

export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Target {
  refId: string;
  datasourceId: string;
  query: unknown;
  /** Kept with the panel but not run (the editor's Hide). */
  hide?: boolean | undefined;
}

export interface PanelModel {
  id: string;
  type: string;
  title: string;
  grid: GridPos;
  targets: Target[];
  transformations: unknown[];
  options: unknown;
  fieldConfig: unknown;
  /** The row the panel belongs to; its grid then counts from the top of that row. */
  rowId?: string;
  repeat?: PanelRepeat;
  /** A relative range of its own ("now-24h") instead of the dashboard's. */
  timeFrom?: string;
  /** Moves the range back by this length ("1d"). */
  timeShift?: string;
  links?: PanelLink[];
  /** Shows this library panel: queries, type and options come from there. */
  libraryPanelId?: string;
  /**
   * Shows this saved analysis: its queries and steps come from there and follow its saves; the
   * stored panel keeps no queries of its own (docs/api/analyses.md, "Linked panels").
   */
  analysisId?: string;
  /** What the panel shows, up to 1000 characters; the header offers it as a hint. */
  description?: string;
  /** Drawn without the card's surface and border. */
  transparent?: boolean;
}

export interface PanelRepeat {
  variable: string;
  direction: "horizontal" | "vertical";
  maxPerRow?: number;
}

export interface PanelLink {
  title: string;
  /** May hold variables (`${name}`); checked again after they are filled in. */
  url: string;
  newTab?: boolean;
}

/** The longest panel description the server keeps. */
export const MAX_DESCRIPTION_CHARS = 1000;

export interface RowModel {
  id: string;
  title: string;
  collapsed: boolean;
  repeat?: { variable: string };
}

export interface AnnotationQueryModel {
  id: string;
  name: string;
  datasourceId: string;
  query: unknown;
  enabled: boolean;
  /** 1 to 8, an entry of the chart palette. */
  color?: number;
}

export type DashboardLinkModel =
  | { type: "dashboards"; tag: string; title: string; newTab?: boolean }
  | { type: "url"; title: string; url: string; newTab?: boolean };

/** A variable's value: one text, or several for a multi-value variable. */
export type VariableValue = string | string[];
export type VariableValues = Record<string, VariableValue>;

/** Every variable type the model allows (docs/api/settings-dashboards.md). */
export const ALL_VARIABLE_TYPES = ["custom", "textbox", "query", "constant", "interval"] as const;
export type VariableType = (typeof ALL_VARIABLE_TYPES)[number];
/** The types the settings dialog offers; constant and interval are kept when stored. */
export const VARIABLE_TYPES = ["custom", "textbox", "query"] as const;

/**
 * A dashboard variable. `custom` and `interval` offer fixed values, `textbox` takes free text,
 * `query` asks the server for its options, `constant` is fixed and not shown. The value always
 * reaches queries as a bind parameter.
 */
export interface VariableModel {
  name: string;
  label?: string;
  type: VariableType;
  /**
   * `custom` and `interval`: the values to choose from. Kept as stored (the server allows any
   * JSON), so numbers or objects survive a save; `optionValues` reads them as text.
   */
  options?: unknown;
  /** `query`: where the options come from. */
  datasourceId?: string;
  /** Kept for every type as stored, also on a constant. */
  query?: unknown;
  /** The value the dashboard opens with: text, a number or a list, as stored. */
  current?: unknown;
  /** Several values at once (custom and query variables); repeats need it. */
  multi?: boolean;
}

const asText = (value: unknown): string | null =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;

/**
 * The values to send with the saved dashboard's stored queries (panel and options routes): only
 * variables the saved dashboard defines, and no constant, whose value is the dashboard's own and
 * whose sending the server refuses (docs/api/datasources.md, "Variables").
 */
export function storedQueryVariables(
  values: VariableValues,
  saved: readonly VariableModel[],
): VariableValues {
  const allowed = new Set(saved.filter((v) => v.type !== "constant").map((v) => v.name));
  return Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)));
}

/**
 * A variable's fixed choices, whatever JSON they were stored as: plain values (text, numbers,
 * booleans) or `{ value, label }` objects, whose label is shown and whose value is sent.
 */
export function optionChoices(variable: VariableModel): { value: string; label: string }[] {
  if (!Array.isArray(variable.options)) {
    return [];
  }
  const choices: { value: string; label: string }[] = [];
  for (const option of variable.options) {
    const plain = asText(option);
    if (plain !== null) {
      choices.push({ value: plain, label: plain });
    } else if (isRecord(option)) {
      const value = asText(option.value);
      if (value !== null) {
        const label = asText(option.label);
        choices.push({ value, label: label === null || label === "" ? value : label });
      }
    }
  }
  return choices;
}

/** A variable's fixed choices as the values queries receive. */
export function optionValues(variable: VariableModel): string[] {
  return optionChoices(variable).map((choice) => choice.value);
}

/**
 * The variables a panel click may set (a node setting `$customerId`), and which values each
 * takes: free text (`textbox`) and query results (`query`) take any value, `custom` only one of
 * its options. A variable stored with several values (a list) is left alone, so a click never
 * turns it into one string; constants and intervals are not set by clicks.
 */
export function clickTargets(variables: readonly VariableModel[]): {
  names: string[];
  accepts: (name: string, value: string) => boolean;
} {
  const settable = variables.filter(
    (v) =>
      (v.type === "textbox" || v.type === "query" || v.type === "custom") &&
      !Array.isArray(v.current),
  );
  return {
    names: settable.map((v) => v.name),
    accepts: (name, value) => {
      const variable = settable.find((v) => v.name === name);
      if (variable === undefined) return false;
      return variable.type === "custom" ? optionValues(variable).includes(value) : true;
    },
  };
}

/** The value a variable opens with, as text; a stored list opens with its first entry. */
export function currentValue(variable: VariableModel): string | undefined {
  const current = Array.isArray(variable.current) ? variable.current[0] : variable.current;
  return asText(isRecord(current) ? current.value : current) ?? undefined;
}

/** Every stored value of a multi-value variable's `current`, as text. */
export function currentValues(variable: VariableModel): string[] {
  const list = Array.isArray(variable.current) ? variable.current : [variable.current];
  return list
    .map((item) => asText(isRecord(item) ? item.value : item))
    .filter((v): v is string => v !== null && v !== "");
}

/** A value as a list: one text is a list of one, nothing is an empty list. */
export function valueList(value: VariableValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : value === "" ? [] : [value];
}

/** A value as one text, for places that show it in a line: several are joined by commas. */
export function valueText(value: VariableValue | undefined): string {
  return valueList(value).join(", ");
}

/** Every value as one text, for panels that put variables into text (the text panel). */
export function variableTexts(values: VariableValues): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, valueText(value)]),
  );
}

export interface DashboardModel {
  schemaVersion: typeof SCHEMA_VERSION;
  title: string;
  /** Text as typed: "now-6h", "now", or ISO times; resolved to milliseconds per run. */
  timeRange: { from: string; to: string };
  refreshSeconds?: number;
  variables: VariableModel[];
  panels: PanelModel[];
  tags?: string[];
  rows?: RowModel[];
  annotations?: AnnotationQueryModel[];
  links?: DashboardLinkModel[];
  /** An IANA zone, or "browser" for the viewer's browser; absent: each viewer's preference. */
  timeZone?: string;
  /** The first day of a week; absent: each viewer's preference. */
  weekStart?: WeekStart;
  /** The month (1 to 12) the fiscal year starts with; absent: January. */
  fiscalYearStartMonth?: number;
  /** How far back "now" stands ("1m"), leaving out incomplete recent data. */
  nowDelay?: string;
  /** The automatic refresh intervals offered, in seconds, ascending; absent: Kalzit's list. */
  refreshIntervals?: number[];
  /** Whether time panels show the pointer's time in the other time panels too. */
  sharedCursor?: SharedCursor;
}

export const SHARED_CURSORS = ["off", "crosshair", "tooltip"] as const;
export type SharedCursor = (typeof SHARED_CURSORS)[number];

/** The dashboard's own time zone value for the viewer's browser zone. */
export const BROWSER_ZONE = "browser";

export const DEFAULT_TIME_RANGE = { from: "now-6h", to: "now" };

export function emptyModel(title: string): DashboardModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    timeRange: { ...DEFAULT_TIME_RANGE },
    variables: [],
    panels: [],
  };
}

function int(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
}

function parseGrid(value: unknown): GridPos {
  const grid = isRecord(value) ? value : {};
  const w = Math.min(Math.max(int(grid.w, 12), 1), GRID_COLUMNS);
  return {
    x: Math.min(Math.max(int(grid.x, 0), 0), GRID_COLUMNS - w),
    y: Math.max(int(grid.y, 0), 0),
    w,
    h: Math.max(int(grid.h, 8), 1),
  };
}

function parseTarget(value: unknown, index: number): Target | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    refId: typeof value.refId === "string" ? value.refId : refIdAt(index),
    datasourceId: typeof value.datasourceId === "string" ? value.datasourceId : "",
    query: value.query ?? null,
    // Dropping it would run a hidden query and lose the flag at the next save.
    ...(value.hide === true ? { hide: true } : {}),
  };
}

function parsePanel(value: unknown, index: number): PanelModel | null {
  if (!isRecord(value)) {
    return null;
  }
  const targets = Array.isArray(value.targets) ? value.targets : [];
  const panel: PanelModel = {
    id: typeof value.id === "string" ? value.id : `panel-${index + 1}`,
    type: typeof value.type === "string" ? value.type : "table",
    title: typeof value.title === "string" ? value.title : "",
    grid: parseGrid(value.grid),
    targets: targets.map(parseTarget).filter((t) => t !== null),
    transformations: Array.isArray(value.transformations) ? value.transformations : [],
    options: value.options ?? {},
    fieldConfig: value.fieldConfig ?? {},
  };
  for (const key of [
    "rowId",
    "timeFrom",
    "timeShift",
    "libraryPanelId",
    "analysisId",
    "description",
  ] as const) {
    const text = value[key];
    if (typeof text === "string" && text !== "") {
      panel[key] = text;
    }
  }
  if (isRecord(value.repeat) && typeof value.repeat.variable === "string") {
    panel.repeat = {
      variable: value.repeat.variable,
      direction: value.repeat.direction === "vertical" ? "vertical" : "horizontal",
    };
    if (typeof value.repeat.maxPerRow === "number") {
      panel.repeat.maxPerRow = value.repeat.maxPerRow;
    }
  }
  const links = parseLinks(value.links);
  if (links.length > 0) {
    panel.links = links;
  }
  if (value.transparent === true) {
    panel.transparent = true;
  }
  return panel;
}

function parseLinks(value: unknown): PanelLink[] {
  return (Array.isArray(value) ? value : []).flatMap((link) =>
    isRecord(link) && typeof link.url === "string"
      ? [
          {
            title: typeof link.title === "string" ? link.title : "",
            url: link.url,
            ...(link.newTab === true ? { newTab: true } : {}),
          },
        ]
      : [],
  );
}

function parseRow(value: unknown): RowModel | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const row: RowModel = {
    id: value.id,
    title: typeof value.title === "string" ? value.title : "",
    collapsed: value.collapsed === true,
  };
  if (isRecord(value.repeat) && typeof value.repeat.variable === "string") {
    row.repeat = { variable: value.repeat.variable };
  }
  return row;
}

function parseAnnotationQuery(value: unknown): AnnotationQueryModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.datasourceId !== "string") {
    return null;
  }
  const query: AnnotationQueryModel = {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    datasourceId: value.datasourceId,
    query: value.query ?? null,
    enabled: value.enabled !== false,
  };
  if (typeof value.color === "number") {
    query.color = value.color;
  }
  return query;
}

function parseDashboardLink(value: unknown): DashboardLinkModel | null {
  if (!isRecord(value)) {
    return null;
  }
  const title = typeof value.title === "string" ? value.title : "";
  const newTab = value.newTab === true ? { newTab: true } : {};
  if (value.type === "dashboards" && typeof value.tag === "string") {
    return { type: "dashboards", tag: value.tag, title, ...newTab };
  }
  if (value.type === "url" && typeof value.url === "string") {
    return { type: "url", title, url: value.url, ...newTab };
  }
  return null;
}

function parseVariable(value: unknown): VariableModel | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name === "") {
    return null;
  }
  const type = ALL_VARIABLE_TYPES.find((t) => t === value.type) ?? "textbox";
  const variable: VariableModel = { name: value.name, type };
  if (typeof value.label === "string" && value.label !== "") {
    variable.label = value.label;
  }
  if (value.options !== undefined) {
    variable.options = value.options;
  }
  if (typeof value.datasourceId === "string") {
    variable.datasourceId = value.datasourceId;
  }
  if (value.query !== undefined) {
    variable.query = value.query;
  }
  if (value.current !== undefined) {
    variable.current = value.current;
  }
  if (value.multi === true) {
    variable.multi = true;
  }
  return variable;
}

/**
 * Drops what the server refuses: a `datasourceId` on anything but a query variable (the dialog
 * may have set one before a type change) and an empty label or current value. Everything else is
 * kept as stored.
 */
export function cleanVariable(variable: VariableModel): VariableModel {
  const clean: VariableModel = { ...variable };
  if (clean.type !== "query") delete clean.datasourceId;
  if (clean.label === "") delete clean.label;
  if (clean.current === "" || (Array.isArray(clean.current) && clean.current.length === 0)) {
    delete clean.current;
  }
  if (clean.multi !== true || (clean.type !== "custom" && clean.type !== "query")) {
    delete clean.multi;
  }
  return clean;
}

export function parseModel(value: unknown, fallbackTitle: string): DashboardModel {
  const model = isRecord(value) ? value : {};
  const range = isRecord(model.timeRange) ? model.timeRange : {};
  const parsed: DashboardModel = {
    schemaVersion: SCHEMA_VERSION,
    title: typeof model.title === "string" ? model.title : fallbackTitle,
    timeRange: {
      from: typeof range.from === "string" ? range.from : DEFAULT_TIME_RANGE.from,
      to: typeof range.to === "string" ? range.to : DEFAULT_TIME_RANGE.to,
    },
    variables: (Array.isArray(model.variables) ? model.variables : [])
      .map(parseVariable)
      .filter((v) => v !== null),
    panels: (Array.isArray(model.panels) ? model.panels : [])
      .map(parsePanel)
      .filter((p) => p !== null),
  };
  if (typeof model.refreshSeconds === "number" && model.refreshSeconds > 0) {
    parsed.refreshSeconds = model.refreshSeconds;
  }
  // Version 2 parts appear only when set, so a dashboard without them reads as before.
  const tags = (Array.isArray(model.tags) ? model.tags : []).filter(
    (t): t is string => typeof t === "string",
  );
  if (tags.length > 0) parsed.tags = tags;
  const rows = (Array.isArray(model.rows) ? model.rows : [])
    .map(parseRow)
    .filter((r) => r !== null);
  if (rows.length > 0) parsed.rows = rows;
  const annotations = (Array.isArray(model.annotations) ? model.annotations : [])
    .map(parseAnnotationQuery)
    .filter((a) => a !== null);
  if (annotations.length > 0) parsed.annotations = annotations;
  const links = (Array.isArray(model.links) ? model.links : [])
    .map(parseDashboardLink)
    .filter((l) => l !== null);
  if (links.length > 0) parsed.links = links;
  parseTimeOptions(model, parsed);
  return parsed;
}

/** The dashboard's time options, each only when it holds a value the server accepts. */
function parseTimeOptions(model: Record<string, unknown>, parsed: DashboardModel): void {
  if (typeof model.timeZone === "string" && model.timeZone !== "") {
    parsed.timeZone = model.timeZone;
  }
  const weekStart = WEEK_STARTS.find((w) => w === model.weekStart);
  if (weekStart !== undefined) parsed.weekStart = weekStart;
  const month = model.fiscalYearStartMonth;
  if (typeof month === "number" && Number.isInteger(month) && month >= 1 && month <= 12) {
    parsed.fiscalYearStartMonth = month;
  }
  if (typeof model.nowDelay === "string" && model.nowDelay !== "") {
    parsed.nowDelay = model.nowDelay;
  }
  const intervals = (Array.isArray(model.refreshIntervals) ? model.refreshIntervals : []).filter(
    (s): s is number => typeof s === "number" && Number.isInteger(s) && s > 0,
  );
  if (intervals.length > 0) parsed.refreshIntervals = intervals;
  const cursor = SHARED_CURSORS.find((c) => c === model.sharedCursor);
  if (cursor !== undefined) parsed.sharedCursor = cursor;
}

/**
 * The model as the server stores it: empty version 2 parts left out, so comparing a draft with
 * the saved model does not see a change where there is none.
 */
export function normalizeModel(model: DashboardModel): DashboardModel {
  return parseModel(JSON.parse(JSON.stringify(model)), model.title);
}

/** "A", "B", ... "Z", "AA": the reference id of the nth target. */
export function refIdAt(index: number): string {
  let id = "";
  let n = index;
  do {
    id = String.fromCharCode(65 + (n % 26)) + id;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return id;
}

/** The first reference id no target uses yet. */
export function nextRefId(targets: readonly Target[]): string {
  const used = new Set(targets.map((t) => t.refId));
  for (let i = 0; ; i++) {
    const id = refIdAt(i);
    if (!used.has(id)) {
      return id;
    }
  }
}

export function newPanelId(): string {
  return crypto.randomUUID();
}

function overlaps(a: GridPos, b: GridPos): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Keeps a position inside the server's limits: 24 columns, h 2 to 200, y up to 10,000. */
export function clampGrid(grid: GridPos): GridPos {
  const w = Math.min(Math.max(grid.w, MIN_PANEL_WIDTH), GRID_COLUMNS);
  const h = Math.min(Math.max(grid.h, MIN_PANEL_HEIGHT), MAX_PANEL_HEIGHT);
  return {
    x: Math.min(Math.max(grid.x, 0), GRID_COLUMNS - w),
    y: Math.min(Math.max(grid.y, 0), MAX_GRID_Y),
    w,
    h,
  };
}

/**
 * Moves or resizes one panel and pushes every panel it now overlaps further down, repeatedly, so
 * panels never cover each other. Panels that are not in the way stay where they are.
 */
export function placePanel(panels: readonly PanelModel[], id: string, grid: GridPos): PanelModel[] {
  const placed = clampGrid(grid);
  // Positions are worked out on copies; only a panel whose place changed becomes a new object,
  // so the others keep their identity and their cards are not drawn again.
  const at = panels.map((p) => ({ id: p.id, grid: p.id === id ? placed : { ...p.grid } }));
  const queue = [id];
  // Each push moves a panel strictly down, so this ends; the guard only bounds odd input.
  for (let guard = 0; queue.length > 0 && guard < 10_000; guard++) {
    const moverId = queue.shift() as string;
    const mover = at.find((p) => p.id === moverId);
    if (mover === undefined) {
      continue;
    }
    for (const other of at) {
      if (other.id !== moverId && overlaps(mover.grid, other.grid)) {
        other.grid.y = mover.grid.y + mover.grid.h;
        queue.push(other.id);
      }
    }
  }
  return panels.map((p, index) => {
    const next = (at[index] as (typeof at)[number]).grid;
    const same =
      next.x === p.grid.x && next.y === p.grid.y && next.w === p.grid.w && next.h === p.grid.h;
    return same ? p : { ...p, grid: next };
  });
}

/** The first row below every panel, where a new panel goes. */
export function bottomRow(panels: readonly PanelModel[]): number {
  return panels.reduce((max, p) => Math.max(max, p.grid.y + p.grid.h), 0);
}

/** Panels in reading order (top to bottom, left to right), for focus order and screen readers. */
export function readingOrder(panels: readonly PanelModel[]): PanelModel[] {
  return [...panels].sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
}
