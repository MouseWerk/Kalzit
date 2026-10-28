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
// Kalzit checks the events with `kalzit_plugin_api::panel::parse_event`; the Rust constants
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

export type PanelEvent = ReadyEvent | ClickEvent | SelectEvent | RangeEvent | SetVariableEvent | ResizeEvent;
