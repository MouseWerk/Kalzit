import { isRecord } from "../../api/client";

/**
 * The dashboard model (docs/ARCHITECTURE.md, "Dashboards"), schemaVersion 2. The server migrates
 * older models on read; the UI still parses defensively, so one odd panel cannot break the page.
 */

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
}

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
  values: Record<string, string>,
  saved: readonly VariableModel[],
): Record<string, string> {
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

export interface DashboardModel {
  schemaVersion: 2;
  title: string;
  /** Text as typed: "now-6h", "now", or ISO times; resolved to milliseconds per run. */
  timeRange: { from: string; to: string };
  refreshSeconds?: number;
  variables: VariableModel[];
  panels: PanelModel[];
}

export const DEFAULT_TIME_RANGE = { from: "now-6h", to: "now" };

export function emptyModel(title: string): DashboardModel {
  return {
    schemaVersion: 2,
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
  };
}

function parsePanel(value: unknown, index: number): PanelModel | null {
  if (!isRecord(value)) {
    return null;
  }
  const targets = Array.isArray(value.targets) ? value.targets : [];
  return {
    id: typeof value.id === "string" ? value.id : `panel-${index + 1}`,
    type: typeof value.type === "string" ? value.type : "table",
    title: typeof value.title === "string" ? value.title : "",
    grid: parseGrid(value.grid),
    targets: targets.map(parseTarget).filter((t) => t !== null),
    transformations: Array.isArray(value.transformations) ? value.transformations : [],
    options: value.options ?? {},
    fieldConfig: value.fieldConfig ?? {},
  };
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
  if (clean.current === "") delete clean.current;
  return clean;
}

export function parseModel(value: unknown, fallbackTitle: string): DashboardModel {
  const model = isRecord(value) ? value : {};
  const range = isRecord(model.timeRange) ? model.timeRange : {};
  const parsed: DashboardModel = {
    schemaVersion: 2,
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
  return parsed;
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
  const result = panels.map((p) =>
    p.id === id ? { ...p, grid: placed } : { ...p, grid: { ...p.grid } },
  );
  const queue = [id];
  // Each push moves a panel strictly down, so this ends; the guard only bounds odd input.
  for (let guard = 0; queue.length > 0 && guard < 10_000; guard++) {
    const moverId = queue.shift() as string;
    const mover = result.find((p) => p.id === moverId);
    if (mover === undefined) {
      continue;
    }
    for (const other of result) {
      if (other.id !== moverId && overlaps(mover.grid, other.grid)) {
        other.grid.y = mover.grid.y + mover.grid.h;
        queue.push(other.id);
      }
    }
  }
  return result;
}

/** The first row below every panel, where a new panel goes. */
export function bottomRow(panels: readonly PanelModel[]): number {
  return panels.reduce((max, p) => Math.max(max, p.grid.y + p.grid.h), 0);
}

/** Panels in reading order (top to bottom, left to right), for focus order and screen readers. */
export function readingOrder(panels: readonly PanelModel[]): PanelModel[] {
  return [...panels].sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
}
