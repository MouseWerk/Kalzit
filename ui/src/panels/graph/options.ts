import { isRecord } from "../../api/client";
import { clipChars } from "../../lib/chars";
import { MAX_EXPAND_LIMIT } from "./adapter";

/** The hard cap on drawn nodes per panel; the panel's own limit may only be lower. */
export const MAX_NODE_LIMIT = 20_000;
export const DEFAULT_NODE_LIMIT = 5_000;
/**
 * Above this many nodes or edges, whichever comes first, the network groups nodes by label until
 * a group is opened: the renderer takes its graph in one piece, and beyond these sizes that is a
 * noticeable pause.
 */
export const AUTO_CLUSTER_NODES = 2_000;
export const AUTO_CLUSTER_EDGES = 8_000;
export const DEFAULT_EXPAND_LIMIT = 25;

export const COLOR_BY = ["label", "community", "component"] as const;
export type ColorBy = (typeof COLOR_BY)[number];
export const CLUSTER_MODES = ["auto", "label", "off"] as const;
export type ClusterMode = (typeof CLUSTER_MODES)[number];

export interface GraphPanelOptions {
  /** Node property shown as its name; empty picks name, title and the like. */
  caption: string;
  colorBy: ColorBy;
  /** "degree", "" for one size, or a node property key. */
  sizeBy: string;
  /** "" for one width, or an edge property key. */
  edgeWidthBy: string;
  nodeLimit: number;
  cluster: ClusterMode;
  /** Edge property with a timestamp; turns on the time slider. */
  timeProperty: string;
  explorer: boolean;
  expandLimit: number;
  /** Dashboard variable a click on a node sets; empty sets none. */
  variable: string;
  /** Node property the variable takes; empty takes the node id. */
  variableProperty: string;
}

/** Longest caption, property key or variable name the graph panels store. */
export const MAX_OPTION_TEXT = 100;

/**
 * A one-line option text as the graph panels store it: control characters (a pasted tab) taken
 * out, the ends trimmed, cut to MAX_OPTION_TEXT. The server refuses control characters
 * (`panel_options`), so what is stored is what it accepts.
 */
export function optionText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  // \p{Cc}: the characters Rust's `char::is_control` names, which the server refuses.
  return clipChars(value.replace(/\p{Cc}/gu, "").trim(), MAX_OPTION_TEXT);
}

const text = optionText;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function parseGraphOptions(stored: unknown): GraphPanelOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    caption: text(value.caption),
    colorBy: COLOR_BY.find((c) => c === value.colorBy) ?? "label",
    sizeBy: text(value.sizeBy, "degree"),
    edgeWidthBy: text(value.edgeWidthBy),
    nodeLimit: clampInt(value.nodeLimit, 1, MAX_NODE_LIMIT, DEFAULT_NODE_LIMIT),
    cluster: CLUSTER_MODES.find((c) => c === value.cluster) ?? "auto",
    timeProperty: text(value.timeProperty),
    explorer: value.explorer === true,
    expandLimit: clampInt(value.expandLimit, 1, MAX_EXPAND_LIMIT, DEFAULT_EXPAND_LIMIT),
    variable: text(value.variable).replace(/^\$/, ""),
    variableProperty: text(value.variableProperty),
  };
}
