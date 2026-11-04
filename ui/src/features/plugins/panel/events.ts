import { valueAt } from "../../../documents/paths";
import { clipChars } from "../../../lib/chars";
import { graphValue } from "../../../panels/dataLinks";
import {
  isMultiVariable,
  type PanelHost,
  setVariableFromClick,
  setVariableValues,
  type VariableClick,
} from "../../../panels/host";
import type { PanelSeries } from "../../../panels/types";
import { clickOption, MAX_VARIABLE_CHARS, variableText } from "../../../panels/variableClick";
import type { PanelEvent } from "./protocol";

/**
 * The key in a plugin panel's options that holds Kalzit's own click setting, apart from the
 * options the plugin declares: `{ "variable": "customer", "source": "id" }`, the dashboard
 * variable a click or a selection in the panel sets and the column, document path or node
 * property its value comes from (as the table, document and graph panels have it). An option
 * name of a manifest cannot start with `$`, so the key never meets one; the plugin never sees it.
 */
export const CLICK_KEY = "$click";

/** Longest field a click setting names (a column, a document path, a property key). */
export const MAX_CLICK_SOURCE_CHARS = 200;

export interface ClickSetting {
  variable: string;
  source: string;
}

/** The click setting as stored, cleaned; none when it sets no variable. */
export function clickSetting(options: Readonly<Record<string, unknown>>): ClickSetting | null {
  const stored = options[CLICK_KEY];
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return null;
  }
  const record = stored as Record<string, unknown>;
  const variable = clickOption(record.variable, MAX_VARIABLE_CHARS, true);
  const source = clickOption(record.source, MAX_CLICK_SOURCE_CHARS);
  return variable === "" ? null : { variable, source };
}

/** The click setting of stored options, cleaned, as the panel's options keep it; else nothing. */
export function storedClickSetting(stored: unknown): Record<string, ClickSetting> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return {};
  }
  const setting = clickSetting(stored as Record<string, unknown>);
  return setting === null ? {} : { [CLICK_KEY]: setting };
}

/** The options the plugin sees: only its own, without Kalzit's click setting. */
export function pluginOptions(options: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { [CLICK_KEY]: _, ...own } = options;
  return own;
}

/**
 * Options a panel asks for in the editor (`setOptions`) with the click setting kept: the panel
 * replaces its own options, not Kalzit's.
 */
export function withClickSetting(
  next: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return current[CLICK_KEY] === undefined
    ? { ...next }
    : { ...next, [CLICK_KEY]: current[CLICK_KEY] };
}

/** The value one row, document, node or edge of a result has in `source`, as variable text. */
function itemValue(
  series: readonly PanelSeries[],
  refId: string,
  target: "row" | "document" | "node" | "edge",
  key: number | string,
  source: string,
): string | null {
  const result = series.find((s) => s.refId === refId)?.result;
  if (result === undefined) {
    return null;
  }
  // Without a field, as the built-in panels: the first column, a document's _id, the id.
  if (result.shape === "frame" && target === "row" && typeof key === "number") {
    const fields = result.frame.fields;
    const field = source === "" ? fields[0] : fields.find((f) => f.name === source);
    return field === undefined || key >= field.values.length
      ? null
      : variableText(field.values[key]);
  }
  if (result.shape === "documents" && target === "document" && typeof key === "number") {
    const document = result.documents.documents[key];
    return document === undefined ? null : variableText(valueAt(document, source || "_id"));
  }
  if (result.shape === "graph" && typeof key === "string") {
    if (target === "node") {
      const node = result.graph.nodes.find((n) => n.id === key);
      return node === undefined
        ? null
        : variableText(graphValue(node.properties, source || "id", node.id));
    }
    if (target === "edge") {
      const edge = result.graph.edges.find((e) => e.id === key);
      return edge === undefined
        ? null
        : source === ""
          ? edge.id
          : variableText(graphValue(edge.properties, source));
    }
  }
  return null;
}

/** What the host did with an event the panel sent, for the console and the live region. */
export type Outcome =
  | { kind: "range"; from: number; to: number }
  | { kind: "variable"; name: string; value: string; result: VariableClick }
  | { kind: "variables"; name: string; values: string[]; result: VariableClick }
  | { kind: "dropped"; reason: string };

/**
 * The times a range from a panel may name: the years 0000 to 9999, which the stored ISO text
 * (`toStoredAbsolute`) and the server's parser both hold.
 */
export const MIN_TIME_MS = -62_167_219_200_000;
export const MAX_TIME_MS = 253_402_300_799_999;
/** A range from a panel spans at least a second and at most ten years; longer is cut at its end. */
export const MIN_RANGE_MS = 1000;
export const MAX_RANGE_MS = 10 * 366 * 86_400_000;

/**
 * The range a panel asked for, fitted: at least a second (`to` moves out) and at most ten years
 * (`from` moves in, so the end the panel showed stays). Null when it names a time outside the
 * years 0000 to 9999.
 */
export function fitRange(from: number, to: number): { from: number; to: number } | null {
  const end = Math.max(to, from + MIN_RANGE_MS);
  const start = Math.max(from, end - MAX_RANGE_MS);
  if (start < MIN_TIME_MS || end > MAX_TIME_MS) {
    return null;
  }
  return { from: start, to: end };
}

/**
 * The events that change the dashboard (`range`, `setVariable`, `click`, `select`): one per
 * second per panel, and only while the viewer has just clicked or typed (the browser's transient
 * user activation, which a click in the frame gives the page too). Where the browser does not
 * report activation, the rate limit alone applies.
 */
export const MAX_ACTIONS_PER_SECOND = 1;

export function userActive(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
    .userActivation;
  return activation === undefined || activation.isActive;
}

/** The values a `setVariable` may set: for a query variable, only options its picker loaded. */
function loadedOnly(host: PanelHost, name: string, values: readonly string[]): string[] {
  const loaded = host.variables?.loadedOptions?.(name);
  return loaded === undefined ? [...values] : values.filter((v) => loaded.includes(v));
}

/**
 * Acts on `click`, `select`, `range` and `setVariable` as the built-in panels do: a range sets
 * the dashboard's time range (as the time picker does, not while it is edited); a click or a
 * selection sets the variable of the panel's click setting from the clicked or selected items of
 * its own results, like a click in a table, document or graph panel; `setVariable` may set only
 * that same variable. A variable is set only when the dashboard lets a panel set it and it takes
 * the value (a `custom` one only its options, a `query` one from `setVariable` only options its
 * picker loaded; constants, intervals and data source variables never). Nothing else is touched.
 */
export function actOnEvent(
  event: PanelEvent,
  host: PanelHost,
  series: readonly PanelSeries[],
  options: Readonly<Record<string, unknown>>,
): Outcome {
  switch (event.type) {
    case "range": {
      if (host.setRange === undefined) {
        return {
          kind: "dropped",
          reason: "range: this page has no time range a panel may set (or it is being edited)",
        };
      }
      const range = fitRange(event.from, event.to);
      if (range === null) {
        return { kind: "dropped", reason: "range: from and to are outside the years 0000 to 9999" };
      }
      host.setRange(range.from, range.to);
      return { kind: "range", ...range };
    }
    case "setVariable": {
      const { name, value } = event;
      if (clickSetting(options)?.variable !== name) {
        return {
          kind: "dropped",
          reason: `setVariable: $${name} is not the variable of the panel's click setting`,
        };
      }
      if (Array.isArray(value)) {
        if (!isMultiVariable(host, name)) {
          return {
            kind: "dropped",
            reason: `setVariable: $${name} is not a multi-value variable a panel may set`,
          };
        }
        const taken = loadedOnly(host, name, value);
        const result = taken.length === 0 ? "refused" : setVariableValues(host, name, taken);
        return { kind: "variables", name, values: value, result };
      }
      if (loadedOnly(host, name, [value]).length === 0) {
        return { kind: "variable", name, value, result: "refused" };
      }
      const result = setVariableFromClick(host, name, value);
      return result === "none"
        ? { kind: "dropped", reason: `setVariable: $${name} is not a variable a panel may set` }
        : { kind: "variable", name, value, result };
    }
    case "click": {
      const setting = clickSetting(options);
      if (setting === null) {
        return { kind: "dropped", reason: "click: the panel sets no variable on click" };
      }
      const key = event.index ?? event.id;
      const value =
        key === undefined
          ? null
          : itemValue(series, event.refId, event.target, key, setting.source);
      if (value === null || value === "") {
        return {
          kind: "dropped",
          reason: `click: the ${event.target} of ${event.refId} has no value in ${setting.source || "its default field"}`,
        };
      }
      const result = setVariableFromClick(host, setting.variable, value);
      return result === "none"
        ? {
            kind: "dropped",
            reason: `click: $${setting.variable} is not a variable a panel may set`,
          }
        : { kind: "variable", name: setting.variable, value, result };
    }
    case "select": {
      const setting = clickSetting(options);
      if (setting === null || !isMultiVariable(host, setting.variable)) {
        return {
          kind: "dropped",
          reason: "select: the panel sets no multi-value variable from a selection",
        };
      }
      // A selection names rows of a frame or documents of a set; a graph has no rows.
      const result = series.find((s) => s.refId === event.refId)?.result;
      if (result === undefined || result.shape === "graph") {
        return {
          kind: "dropped",
          reason: `select: ${event.refId} is not a frame or document result of the panel`,
        };
      }
      const target = result.shape === "documents" ? "document" : "row";
      const values = [
        ...new Set(
          event.rows
            .map((row) => itemValue(series, event.refId, target, row, setting.source))
            .filter((v): v is string => v !== null && v !== ""),
        ),
      ];
      if (values.length === 0) {
        return { kind: "dropped", reason: `select: no selected row of ${event.refId} has a value` };
      }
      const outcome = setVariableValues(host, setting.variable, values);
      return { kind: "variables", name: setting.variable, values, result: outcome };
    }
    default:
      return { kind: "dropped", reason: `${event.type} is not acted on here` };
  }
}

/** A list of values as the live region reads it: the first few, then how many more. */
export function valuesText(values: readonly string[]): string {
  const shown = values.slice(0, 3).map((v) => clipChars(v, 40));
  return values.length > 3 ? `${shown.join(", ")}, +${values.length - 3}` : shown.join(", ");
}
