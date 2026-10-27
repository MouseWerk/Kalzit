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

export const COLOR_BY = ["label", "property", "community", "component"] as const;
export type ColorBy = (typeof COLOR_BY)[number];
export const CLUSTER_MODES = ["auto", "label", "off"] as const;
export type ClusterMode = (typeof CLUSTER_MODES)[number];
/** Colors by a property: a ramp of five steps for numbers, or a palette color per text value. */
export const COLOR_SCHEMES = ["blues", "gyr", "grays", "values"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];
export const COLOR_RANGES = ["auto", "fixed"] as const;
export type ColorRange = (typeof COLOR_RANGES)[number];
/** When arrows and edge type labels are drawn. */
export const SHOW_WHEN = ["selection", "always", "never"] as const;
export type ShowWhen = (typeof SHOW_WHEN)[number];
/** Which node labels show: by zoom level, all of them, or only those of the selection. */
export const LABEL_MODES = ["zoom", "always", "selection"] as const;
export type LabelMode = (typeof LABEL_MODES)[number];
/** What a click on a node does, besides selecting it. */
export const CLICK_ACTIONS = ["details", "variable", "expand"] as const;
export type ClickAction = (typeof CLICK_ACTIONS)[number];
/** Palette colors a label can take: the theme's chart colors, as the other panels store them. */
export const LABEL_TONES = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
] as const;
export type LabelTone = (typeof LABEL_TONES)[number];

/** Node sizes on screen, in px. */
export const MIN_SIZE = 2;
export const MAX_SIZE = 40;
export const DEFAULT_SIZE_MIN = 4;
export const DEFAULT_SIZE_MAX = 14;
/** At most this many of the largest nodes are always labelled. */
export const MAX_LABEL_TOP = 200;
/** At most this many labels carry a color of their own. */
export const MAX_LABEL_COLORS = 50;

export interface GraphPanelOptions {
  /** Node property shown as its name; empty picks name, title and the like. */
  caption: string;
  colorBy: ColorBy;
  /** The node property `colorBy: "property"` reads. */
  colorProperty: string;
  colorScheme: ColorScheme;
  colorRange: ColorRange;
  /** The fixed range of `colorRange: "fixed"`; null takes the result's own end. */
  colorMin: number | null;
  colorMax: number | null;
  /** A palette color per label, instead of the palette's order. */
  labelColors: Record<string, LabelTone>;
  /** "degree", "" for one size, or a node property key. */
  sizeBy: string;
  sizeMin: number;
  sizeMax: number;
  /** "" for one width, or an edge property key. */
  edgeWidthBy: string;
  arrows: ShowWhen;
  edgeLabels: ShowWhen;
  labels: LabelMode;
  /** The largest nodes always labelled, whatever the zoom; 0 for none. */
  labelTop: number;
  nodeLimit: number;
  cluster: ClusterMode;
  /** Edge property with a timestamp; turns on the time slider. */
  timeProperty: string;
  explorer: boolean;
  expandLimit: number;
  clickAction: ClickAction;
  /** Whether a click that sets a variable or loads neighbours also opens the details. */
  clickDetails: boolean;
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

function choice<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return list.find((c) => c === value) ?? fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function labelColors(value: unknown): Record<string, LabelTone> {
  if (!isRecord(value)) return {};
  const out: Record<string, LabelTone> = {};
  for (const [label, tone] of Object.entries(value)) {
    const name = text(label);
    const known = LABEL_TONES.find((t) => t === tone);
    if (name !== "" && known !== undefined && Object.keys(out).length < MAX_LABEL_COLORS) {
      out[name] = known;
    }
  }
  return out;
}

export function parseGraphOptions(stored: unknown): GraphPanelOptions {
  const value = isRecord(stored) ? stored : {};
  const variable = text(value.variable).replace(/^\$/, "");
  const explorer = value.explorer === true;
  // Options stored before the click action existed: a variable or explorer mode decided it.
  const legacyAction: ClickAction = variable !== "" ? "variable" : explorer ? "expand" : "details";
  const sizeMin = clampInt(value.sizeMin, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE_MIN);
  const sizeMax = clampInt(value.sizeMax, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE_MAX);
  return {
    caption: text(value.caption),
    colorBy: choice(COLOR_BY, value.colorBy, "label"),
    colorProperty: text(value.colorProperty),
    colorScheme: choice(COLOR_SCHEMES, value.colorScheme, "blues"),
    colorRange: choice(COLOR_RANGES, value.colorRange, "auto"),
    colorMin: finiteOrNull(value.colorMin),
    colorMax: finiteOrNull(value.colorMax),
    labelColors: labelColors(value.labelColors),
    sizeBy: text(value.sizeBy, "degree"),
    sizeMin: Math.min(sizeMin, sizeMax),
    sizeMax: Math.max(sizeMin, sizeMax),
    edgeWidthBy: text(value.edgeWidthBy),
    arrows: choice(SHOW_WHEN, value.arrows, "always"),
    edgeLabels: choice(SHOW_WHEN, value.edgeLabels, "never"),
    labels: choice(LABEL_MODES, value.labels, "zoom"),
    labelTop: clampInt(value.labelTop, 0, MAX_LABEL_TOP, 0),
    nodeLimit: clampInt(value.nodeLimit, 1, MAX_NODE_LIMIT, DEFAULT_NODE_LIMIT),
    cluster: choice(CLUSTER_MODES, value.cluster, "auto"),
    timeProperty: text(value.timeProperty),
    explorer,
    expandLimit: clampInt(value.expandLimit, 1, MAX_EXPAND_LIMIT, DEFAULT_EXPAND_LIMIT),
    clickAction: choice(CLICK_ACTIONS, value.clickAction, legacyAction),
    clickDetails: value.clickDetails !== false,
    variable,
    variableProperty: text(value.variableProperty),
  };
}
