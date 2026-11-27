import { isRecord } from "../../api/client";
import { clipChars } from "../../lib/chars";
import { type DataLink, parseDataLinks } from "../dataLinks";
import { MAX_EXPAND_LIMIT } from "./adapter";
import type { PinnedPlace } from "./canvas/edits";
import { type GraphStyle, parseGraphStyle } from "./style/schema";

/** Properties per label on a node's info card (`MAX_INFO_CARD_PROPERTIES` on the server). */
export const CARD_PROPERTIES = 4;
/** Labels with their own choice of info card properties, as the panel options keep them. */
export const MAX_CARD_LABELS = 50;
/** Nodes pinned with the panel, their longest id and largest coordinate (the server's bounds). */
export const MAX_PANEL_PINS = 200;
const MAX_PIN_ID_CHARS = 512;
const MAX_PIN_COORDINATE = 1e9;

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
/** The shapes a node can take, a second cue next to its color (shapes.ts). */
export const NODE_SHAPES = ["circle", "square", "diamond"] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

/**
 * How the hierarchy lays out: Kalzit's own layered layout (the default), or ELK's layered
 * algorithm, which loads only when a panel picks it (elkLayout.ts).
 */
export const HIERARCHY_LAYOUTS = ["kalzit", "elk"] as const;
export type HierarchyLayout = (typeof HIERARCHY_LAYOUTS)[number];
/** Where ELK lets edges point: from the roots down, to the right, up or to the left. */
export const ELK_DIRECTIONS = ["down", "right", "up", "left"] as const;
export type ElkDirection = (typeof ELK_DIRECTIONS)[number];
export const ELK_EDGE_ROUTINGS = ["orthogonal", "polyline"] as const;
export type ElkEdgeRouting = (typeof ELK_EDGE_ROUTINGS)[number];
/** ELK's gaps in px: between the nodes of a layer, and between layers. */
export const ELK_NODE_SPACING = { min: 5, max: 200, default: 30 } as const;
export const ELK_LAYER_SPACING = { min: 10, max: 400, default: 80 } as const;

/**
 * The layouts of a graph panel (Graph081 board, frames 12 and 13). "force" and "hierarchy" are
 * also the two panel types; the others are chosen in the layout menu. The map layout belongs to
 * the map panel and joins this list with it.
 */
export const LAYOUT_MODES = [
  "force",
  "hierarchy",
  "radial",
  "circular",
  "grid",
  "coordinates",
  "timeline",
] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

/**
 * Whether "Arrange again" can give another arrangement: forces start from another seed, radial
 * stands around the nodes selected now. The others are fixed by their input, so asking again
 * would change nothing.
 */
export function canRearrange(mode: LayoutMode): boolean {
  return mode === "force" || mode === "radial";
}

/** Whether a layout reads the seed ("Arrange again" counts it up): only the forces do. */
export function usesSeed(mode: LayoutMode): boolean {
  return mode === "force";
}

/** How a circle or a grid orders its nodes: by label and then name, by name, or by edges. */
export const LAYOUT_ORDERS = ["label", "name", "degree"] as const;
export type LayoutOrder = (typeof LAYOUT_ORDERS)[number];
export const LAYOUT_ORDER_DIRECTIONS = ["asc", "desc"] as const;
export type LayoutOrderDirection = (typeof LAYOUT_ORDER_DIRECTIONS)[number];
/** The lanes of a timeline: one per label, or one for all nodes. */
export const LAYOUT_LANES = ["label", "one"] as const;
export type LayoutLanes = (typeof LAYOUT_LANES)[number];
/** At most this many labels carry a time property of their own for the timeline. */
export const MAX_LAYOUT_TIME_LABELS = 50;

/** Node sizes on screen, in px. */
export const MIN_SIZE = 2;
export const MAX_SIZE = 40;
export const DEFAULT_SIZE_MIN = 4;
export const DEFAULT_SIZE_MAX = 14;
/** At most this many of the largest nodes are always labelled. */
export const MAX_LABEL_TOP = 200;
/** At most this many labels carry a color of their own. */
export const MAX_LABEL_COLORS = 50;
/** At most this many labels carry a shape of their own. */
export const MAX_LABEL_SHAPES = 50;

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
  /** A shape per label, instead of the one its order gives it (shapes.ts). */
  labelShapes: Record<string, NodeShape>;
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
  /** The hierarchy's layout; the ELK settings below apply only to "elk". */
  hierarchyLayout: HierarchyLayout;
  elkDirection: ElkDirection;
  elkNodeSpacing: number;
  elkLayerSpacing: number;
  elkEdgeRouting: ElkEdgeRouting;
  /**
   * The layout the panel opens with (layouts/); empty keeps the panel type's own, forces for a
   * network. The hierarchy panel always starts as a hierarchy.
   */
  layout: LayoutMode | "";
  /** Circle and grid: what the nodes are ordered by, and in which direction. */
  layoutOrder: LayoutOrder;
  layoutOrderDirection: LayoutOrderDirection;
  /** Coordinates: two number properties, or a `point` property, which wins when set. */
  layoutX: string;
  layoutY: string;
  layoutPoint: string;
  /** Coordinates: whether the axes are drawn behind the graph. */
  layoutAxes: boolean;
  /** Timeline: the time property per label; a label without an entry takes its most used one. */
  layoutTime: Record<string, string>;
  layoutLanes: LayoutLanes;
  /** Links from a node property, offered in the node's details. */
  dataLinks: DataLink[];
  /**
   * Style rules on top of the basis (the color, size and shape options above), which holds
   * wherever no rule sets the target (style/schema.ts).
   */
  style: GraphStyle;
  /**
   * Nodes pinned for everyone with the panel, each at the place it was dragged to in the panel
   * editor (Graph 0.8.1 board, frame 14). Only ids and places, never properties.
   */
  pinned: PinnedPlace[];
  /** Up to four properties per node label on the info card, instead of the first ones. */
  infoCard: Record<string, string[]>;
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

/**
 * A value per label from stored options: known values only, at most `max` labels. Built with
 * `Object.fromEntries`, so a label named like an object's own key (`__proto__`, `constructor`)
 * stays a label.
 */
function perLabel<T extends string>(
  value: unknown,
  known: readonly T[],
  max: number,
): Record<string, T> {
  if (!isRecord(value)) return {};
  const out: [string, T][] = [];
  for (const [label, choice] of Object.entries(value)) {
    const name = text(label);
    const found = known.find((k) => k === choice);
    if (name !== "" && found !== undefined && out.length < max && !out.some(([n]) => n === name)) {
      out.push([name, found]);
    }
  }
  return Object.fromEntries(out);
}

/** A property key per label from stored options: non-empty texts, at most `max` labels. */
function textPerLabel(value: unknown, max: number): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: [string, string][] = [];
  for (const [label, key] of Object.entries(value)) {
    const name = text(label);
    const property = text(key);
    if (name !== "" && property !== "" && out.length < max && !out.some(([n]) => n === name)) {
      out.push([name, property]);
    }
  }
  return Object.fromEntries(out);
}

/** Property names per label from stored options: at most `max` labels, `each` names per label. */
function namesPerLabel(value: unknown, max: number, each: number): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const out: [string, string[]][] = [];
  for (const [label, names] of Object.entries(value)) {
    const name = text(label);
    if (name === "" || !Array.isArray(names) || out.length >= max) continue;
    if (out.some(([n]) => n === name)) continue;
    const kept = [...new Set(names.map((n) => text(n)).filter((n) => n !== ""))].slice(0, each);
    out.push([name, kept]);
  }
  return Object.fromEntries(out);
}

/**
 * The panel's pinned nodes as the server keeps them: one per id, ids of 1 to 512 characters
 * without control characters, finite coordinates within 1e9 (rounded to hundredths), at most 200.
 */
function pinnedPlaces(value: unknown): PinnedPlace[] {
  if (!Array.isArray(value)) return [];
  const out: PinnedPlace[] = [];
  const seen = new Set<string>();
  const within = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_PIN_COORDINATE;
  for (const entry of value) {
    if (out.length >= MAX_PANEL_PINS) break;
    if (!isRecord(entry)) continue;
    const { id, x, y } = entry;
    if (typeof id !== "string" || id === "" || [...id].length > MAX_PIN_ID_CHARS) continue;
    if (/\p{Cc}/u.test(id) || seen.has(id) || !within(x) || !within(y)) continue;
    seen.add(id);
    out.push({ id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }
  return out;
}

/** A per-label option with `label` set to `value`, or taken out without one. */
export function withEntry<T>(
  options: Readonly<Record<string, T>>,
  label: string,
  value: T | undefined,
): Record<string, T> {
  const rest = Object.entries(options).filter(([name]) => name !== label);
  return Object.fromEntries(value === undefined ? rest : [...rest, [label, value]]);
}

/** A label's own entry in a per-label option; never one an object inherits. */
export function ownEntry<T>(options: Readonly<Record<string, T>>, label: string): T | undefined {
  return Object.hasOwn(options, label) ? options[label] : undefined;
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
    labelColors: perLabel(value.labelColors, LABEL_TONES, MAX_LABEL_COLORS),
    labelShapes: perLabel(value.labelShapes, NODE_SHAPES, MAX_LABEL_SHAPES),
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
    hierarchyLayout: choice(HIERARCHY_LAYOUTS, value.hierarchyLayout, "kalzit"),
    elkDirection: choice(ELK_DIRECTIONS, value.elkDirection, "down"),
    elkNodeSpacing: clampInt(
      value.elkNodeSpacing,
      ELK_NODE_SPACING.min,
      ELK_NODE_SPACING.max,
      ELK_NODE_SPACING.default,
    ),
    elkLayerSpacing: clampInt(
      value.elkLayerSpacing,
      ELK_LAYER_SPACING.min,
      ELK_LAYER_SPACING.max,
      ELK_LAYER_SPACING.default,
    ),
    elkEdgeRouting: choice(ELK_EDGE_ROUTINGS, value.elkEdgeRouting, "orthogonal"),
    layout: choice([...LAYOUT_MODES, ""] as const, value.layout, ""),
    layoutOrder: choice(LAYOUT_ORDERS, value.layoutOrder, "label"),
    layoutOrderDirection: choice(LAYOUT_ORDER_DIRECTIONS, value.layoutOrderDirection, "asc"),
    layoutX: text(value.layoutX),
    layoutY: text(value.layoutY),
    layoutPoint: text(value.layoutPoint),
    layoutAxes: value.layoutAxes !== false,
    layoutTime: textPerLabel(value.layoutTime, MAX_LAYOUT_TIME_LABELS),
    layoutLanes: choice(LAYOUT_LANES, value.layoutLanes, "label"),
    dataLinks: parseDataLinks(value.dataLinks, MAX_OPTION_TEXT),
    style: parseGraphStyle(value.style),
    pinned: pinnedPlaces(value.pinned),
    infoCard: namesPerLabel(value.infoCard, MAX_CARD_LABELS, CARD_PROPERTIES),
  };
}

/** The ELK settings of a panel's hierarchy; null when it keeps Kalzit's own layout. */
export interface ElkSettings {
  direction: ElkDirection;
  nodeSpacing: number;
  layerSpacing: number;
  edgeRouting: ElkEdgeRouting;
}

export function elkSettings(options: GraphPanelOptions): ElkSettings | null {
  return options.hierarchyLayout === "elk"
    ? {
        direction: options.elkDirection,
        nodeSpacing: options.elkNodeSpacing,
        layerSpacing: options.elkLayerSpacing,
        edgeRouting: options.elkEdgeRouting,
      }
    : null;
}
