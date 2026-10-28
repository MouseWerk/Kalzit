// The Kalzit panel message API, version 1 (docs/api/plugins.md, "Panel message API").
//
// A panel plugin's bundle runs in an <iframe sandbox="allow-scripts"> with an opaque origin and
// no network. It talks to Kalzit only with window.postMessage: Kalzit sends data in
// (`PanelMessage`), the panel sends events out (`PanelEvent`). Every message carries
// `kalzit: "panel"` and `api: 1`.
//
// Rules for a panel:
// - Accept messages only from `window.parent` (`event.source === window.parent`); the origin is
//   "null" on both sides and says nothing.
// - Send `ready` once it listens; Kalzit answers with `init` and the current `data`.
// - Ignore message types and fields it does not know: version 1 grows by new optional fields
//   and new message types.
// - Send events with `window.parent.postMessage(event, "*")`. Kalzit checks each one and drops
//   what does not fit: at most 16 KiB of JSON, at most 20 events per second, the limits below.
//
// - Kalzit acts on `ready`, `resize`, `setOptions` (in edit mode), `link` (after the viewer
//   confirms) and `log`; `click`, `select`, `range` and `setVariable` are checked but not acted
//   on yet.
//
// Kalzit checks the events as `kalzit_plugin_api::panel::parse_event` does; the Rust constants
// there are the limits.

export type ApiVersion = 1;

interface Envelope {
  kalzit: "panel";
  api: 1;
}

// ---- Results, as built-in panels receive them (docs/api/datasources.md, result envelope) ----

export type FieldType = "time" | "number" | "int64" | "string" | "bool" | "json" | "decimal" | "date";

export interface Notice {
  severity: "info" | "warning";
  code: string;
  params?: Record<string, string>;
  text: string;
}

export interface Field {
  name: string;
  type: FieldType;
  unit?: string;
  labels?: Record<string, string>;
  /** One value per row: numbers for time, date and number; strings for int64 and decimal. */
  values: unknown[];
}

export interface Frame {
  fields: Field[];
  meta: { executedQuery?: string; rowsTruncated: boolean; notices: Notice[] };
}

export interface DocumentSet {
  documents: Record<string, unknown>[];
  nextCursor?: string;
  notices: Notice[];
}

export interface GraphSet {
  nodes: { id: string; labels: string[]; properties: Record<string, unknown> }[];
  edges: { id: string; type: string; from: string; to: string; properties: Record<string, unknown> }[];
  paths?: { nodes: string[]; edges: string[] }[];
  schema: { labels: string[]; edgeTypes: string[]; propertyKeys: Record<string, string[]> };
}

export type QueryResult =
  | { shape: "frame"; frame: Frame }
  | { shape: "documents"; documents: DocumentSet }
  | { shape: "graph"; graph: GraphSet };

export interface Series {
  refId: string;
  /** Absent when the query failed. */
  result?: QueryResult;
  error?: { code: string; reason?: string; message: string };
}

export interface Theme {
  scheme: "light" | "dark";
  /** Kalzit's design tokens by CSS custom property name, such as "--color-text": "#1d1d1f". */
  tokens: Record<string, string>;
}

export interface Size {
  /** CSS pixels of the frame. */
  width: number;
  height: number;
}

// ---- Into the frame ----

/** The answer to `ready`: everything the panel needs to draw. */
export interface InitMessage extends Envelope {
  type: "init";
  /** The panel's options as the dashboard stores them (the panel's own JSON object). */
  options: Record<string, unknown>;
  size: Size;
  theme: Theme;
  /** "en" or "de". */
  locale: string;
  /** The dashboard's IANA time zone, such as "Europe/Berlin". */
  timeZone: string;
  /** The panel's title, empty when it has none. */
  title: string;
  /**
   * "edit" in the panel editor, where the panel may send `setOptions`; "view" on a dashboard.
   * Absent from hosts before Kalzit 0.4.0: treat as "view".
   */
  mode?: "view" | "edit";
}

/** New results: after `init`, and whenever the panel's queries ran again. */
export interface DataMessage extends Envelope {
  type: "data";
  series: Series[];
  timeRange: { from: number; to: number };
  /** Grows with every run, so a panel can tell newer data from older. */
  revision: number;
}

export interface OptionsMessage extends Envelope {
  type: "options";
  options: Record<string, unknown>;
}

export interface SizeMessage extends Envelope, Size {
  type: "size";
}

export interface ThemeMessage extends Envelope, Theme {
  type: "theme";
}

/** The queries run (`loading`), so the panel may show that its data is about to change. */
export interface StateMessage extends Envelope {
  type: "state";
  loading: boolean;
}

export type PanelMessage = InitMessage | DataMessage | OptionsMessage | SizeMessage | ThemeMessage | StateMessage;

// ---- Out of the frame ----

/** The panel listens. Send it once, after adding the message listener. */
export interface ReadyEvent extends Envelope {
  type: "ready";
}

/** A row or document (`index` in its result) or a node or edge (`id`) was clicked. */
export type ClickEvent = Envelope & { type: "click"; refId: string } & (
    | { target: "row" | "document"; index: number }
    | { target: "node" | "edge"; id: string }
  );

/** Rows of a frame were selected: at most 1000 indices. */
export interface SelectEvent extends Envelope {
  type: "select";
  refId: string;
  rows: number[];
}

/** A time range was picked, in Unix milliseconds (`from` before `to`). */
export interface RangeEvent extends Envelope {
  type: "range";
  from: number;
  to: number;
}

/**
 * Sets a dashboard variable, when the dashboard has one of that name: a text, or a list of at
 * most 100 texts for a multi-value variable; at most 1024 characters each.
 */
export interface SetVariableEvent extends Envelope {
  type: "setVariable";
  name: string;
  value: string | string[];
}

/** Asks for a height of 16 to 4000 CSS pixels; Kalzit may give less. */
export interface ResizeEvent extends Envelope {
  type: "resize";
  height: number;
}

/**
 * In edit mode only: the panel's options as the panel wants them, the whole object. Kalzit checks
 * them against the options the manifest declares (`[[panel.options]]`: only declared keys, each
 * value of its type and range) and drops them otherwise; then it answers with `options`.
 */
export interface SetOptionsEvent extends Envelope {
  type: "setOptions";
  options: Record<string, unknown>;
}

/**
 * Asks Kalzit to open a link: an `http` or `https` address (without a user name) or a path in
 * Kalzit starting with `/` (not `//`, not the API under `/api`); at most 2048 characters. Kalzit shows the address and opens it only
 * when the viewer confirms; an address opens in a new tab without a referrer.
 */
export interface LinkEvent extends Envelope {
  type: "link";
  url: string;
  /** At most 200 characters, shown with the address. */
  title?: string;
}

/**
 * A line for the panel's log, shown in the browser console with the plugin id: at most 1024
 * characters without control characters, at most 5 lines per second.
 */
export interface LogEvent extends Envelope {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

export type PanelEvent =
  | ReadyEvent
  | ClickEvent
  | SelectEvent
  | RangeEvent
  | SetVariableEvent
  | ResizeEvent
  | SetOptionsEvent
  | LinkEvent
  | LogEvent;

// ---- The options a manifest declares (`[[panel.options]]`) ----

export type PanelOptionType = "string" | "text" | "number" | "integer" | "bool" | "select";

export interface PanelOption {
  name: string;
  /** By language: "en", optionally "de". */
  label: Record<string, string>;
  type: PanelOptionType;
  default?: string | number | boolean;
  /** The choices of a "select". */
  choices?: string[];
  /** The range of a "number" or "integer", inclusive. */
  min?: number;
  max?: number;
  help?: Record<string, string>;
}
