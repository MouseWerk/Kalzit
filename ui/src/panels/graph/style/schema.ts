import { isRecord } from "../../../api/client";
import { clipChars } from "../../../lib/chars";
import iconNames from "./icons/names.txt?raw";

/**
 * Style rules (Graph081 board, frames 8 to 11): what a panel stores under `options.style`. A rule
 * says when it applies (always, on a condition, or per unique value of a property), to which node
 * label or edge type, and what it sets. Rules apply from top to bottom; where two set the same
 * target for the same node or edge, the lower one wins. The basis (color by label, size by
 * degree, shape per label) stays in the panel's other options and holds wherever no rule sets
 * the target.
 *
 * The schema carries a version, so a later form can be read from an older one (`parseGraphStyle`
 * is the only reader). The server checks the same bounds (`panel_options.rs`, `check_style`).
 */

export const STYLE_VERSION = 1;
/** Rules per panel, nodes and edges together. */
export const MAX_STYLE_RULES = 50;
/** Values a rule "per unique value" colors; the rest is "other". */
export const MAX_VALUE_COLORS = 12;
/** Characters of a badge, after its template is filled in. */
export const MAX_BADGE_CHARS = 6;
/** Longest property key, label, edge type, template or condition value of a rule. */
export const MAX_RULE_TEXT = 100;
/** Node sizes a rule may set, in px (the bounds of the panel's size range). */
export const RULE_SIZE = { min: 2, max: 40, default: 14 } as const;
/** Edge widths a rule may set, in px. */
export const RULE_WIDTH = { min: 1, max: 8, default: 3 } as const;

/**
 * Colors a rule may set: the data palette, two neutral tones and the three status tones. Never
 * the accent color.
 */
export const STYLE_COLORS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "neutral",
  "neutral-strong",
  "good",
  "warning",
  "critical",
] as const;
export type StyleColor = (typeof STYLE_COLORS)[number];
/** The colors that state something; the editor asks for a second cue next to them. */
export const STATUS_COLORS: readonly StyleColor[] = ["good", "warning", "critical"];
/** The palette colors, in the order "per unique value" hands them out. */
export const PALETTE_COLORS = STYLE_COLORS.slice(0, 8) as readonly StyleColor[];

export const RULE_SHAPES = ["circle", "square", "diamond", "triangle", "hexagon"] as const;
export type RuleShape = (typeof RULE_SHAPES)[number];
/** A node's frame: always in the text color, never a sign of selection. */
export const RULE_BORDERS = ["none", "solid", "dashed"] as const;
export type RuleBorder = (typeof RULE_BORDERS)[number];
export const EDGE_DASHES = ["solid", "dashed", "dotted"] as const;
export type EdgeDash = (typeof EDGE_DASHES)[number];
export const EDGE_ARROWS = ["direction", "none"] as const;
export type EdgeArrow = (typeof EDGE_ARROWS)[number];

export const VALUE_TYPES = ["number", "text", "date", "boolean"] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** The comparisons of each data type (frame 9). */
export const CONDITION_OPS = {
  number: ["eq", "ne", "lt", "lte", "gt", "gte", "between", "exists", "missing"],
  text: ["eq", "ne", "contains", "notContains", "startsWith", "exists", "missing"],
  date: ["on", "before", "after", "between", "lastDays", "exists", "missing"],
  boolean: ["true", "false", "exists", "missing"],
} as const satisfies Record<ValueType, readonly string[]>;
export type ConditionOp = (typeof CONDITION_OPS)[ValueType][number];

/** How many values a comparison takes: none, one, or the two ends of a range. */
export function operands(op: ConditionOp): 0 | 1 | 2 {
  if (op === "exists" || op === "missing" || op === "true" || op === "false") return 0;
  return op === "between" ? 2 : 1;
}

export interface Condition {
  kind: "condition";
  property: string;
  type: ValueType;
  op: ConditionOp;
  /** The value as typed: a number, a text, a date (`2022-01-01`) or a count of days. */
  value: string;
  /** The upper end of "between". */
  to: string;
  /** Text compares without case unless this is set. */
  caseSensitive: boolean;
}

/** A value's own color in a rule "per unique value"; a value keeps it when the result changes. */
export interface ValueColor {
  value: string;
  color: StyleColor;
}

export type RuleWhen =
  | { kind: "always" }
  | Condition
  | { kind: "values"; property: string; colors: ValueColor[] };

export interface NodeTargets {
  color?: StyleColor;
  /** In px. */
  size?: number;
  shape?: RuleShape;
  /** A name of the icon set (icons/lucide.json). */
  icon?: string;
  border?: RuleBorder;
  /** A text, with `{property}` for a property's value; replaces the node's name. */
  label?: string;
  /** As `label`, at most MAX_BADGE_CHARS once filled in. */
  badge?: string;
}

export interface EdgeTargets {
  color?: StyleColor;
  /** In px. */
  width?: number;
  dash?: EdgeDash;
  label?: string;
  arrow?: EdgeArrow;
}

export interface StyleRule<T> {
  /** Stable within the panel: the editor's key and what the view's history names. */
  id: string;
  on: boolean;
  /** The node label or edge type the rule is for; "" for all. */
  scope: string;
  when: RuleWhen;
  /** What the rule sets. A rule "per unique value" sets the color from its values instead. */
  set: T;
}

export type NodeRule = StyleRule<NodeTargets>;
export type EdgeRule = StyleRule<EdgeTargets>;

export interface GraphStyle {
  /** STYLE_VERSION, or a newer version kept as stored (`parseGraphStyle`). */
  version: number;
  nodes: NodeRule[];
  edges: EdgeRule[];
}

export const EMPTY_STYLE: GraphStyle = { version: STYLE_VERSION, nodes: [], edges: [] };

export const NODE_TARGETS = ["color", "size", "shape", "icon", "border", "label", "badge"] as const;
export const EDGE_TARGETS = ["color", "width", "dash", "label", "arrow"] as const;
export type NodeTarget = (typeof NODE_TARGETS)[number];
export type EdgeTarget = (typeof EDGE_TARGETS)[number];

/** One line of rule text: control characters out, ends trimmed, cut to the limit. */
function text(value: unknown, max = MAX_RULE_TEXT): string {
  if (typeof value !== "string") return "";
  return clipChars(value.replace(/\p{Cc}/gu, "").trim(), max);
}

function choice<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return list.find((entry) => entry === value);
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : undefined;
}

/**
 * The names of the shipped icon set (icons/names.txt, which scripts/graph-icons.mjs draws into
 * icons/lucide.json). Only the names, so the stored form checks them without loading the icons;
 * the server checks against the same file (`panel_style.rs`).
 */
export const ICON_NAME_SET: ReadonlySet<string> = new Set(iconNames.split(/\s+/).filter(Boolean));

/** Whether the shipped icon set has an icon of this name. */
export function isIconName(value: unknown): value is string {
  return typeof value === "string" && ICON_NAME_SET.has(value);
}

function parseWhen(stored: unknown): RuleWhen | null {
  if (!isRecord(stored)) return null;
  if (stored.kind === "always") return { kind: "always" };
  const property = text(stored.property);
  if (property === "") return null;
  if (stored.kind === "values") {
    const colors: ValueColor[] = [];
    for (const entry of Array.isArray(stored.colors) ? stored.colors : []) {
      if (!isRecord(entry)) continue;
      const value = text(entry.value);
      const color = choice(STYLE_COLORS, entry.color);
      if (
        value !== "" &&
        color !== undefined &&
        colors.length < MAX_VALUE_COLORS &&
        !colors.some((known) => known.value === value)
      ) {
        colors.push({ value, color });
      }
    }
    return { kind: "values", property, colors };
  }
  if (stored.kind === "condition") {
    const type = choice(VALUE_TYPES, stored.type);
    if (type === undefined) return null;
    const op = choice<ConditionOp>(CONDITION_OPS[type], stored.op);
    if (op === undefined) return null;
    return {
      kind: "condition",
      property,
      type,
      op,
      value: text(stored.value),
      to: text(stored.to),
      caseSensitive: stored.caseSensitive === true,
    };
  }
  return null;
}

function parseNodeTargets(stored: unknown): NodeTargets {
  const value = isRecord(stored) ? stored : {};
  const out: NodeTargets = {};
  const color = choice(STYLE_COLORS, value.color);
  if (color !== undefined) out.color = color;
  const size = clampInt(value.size, RULE_SIZE.min, RULE_SIZE.max);
  if (size !== undefined) out.size = size;
  const shape = choice(RULE_SHAPES, value.shape);
  if (shape !== undefined) out.shape = shape;
  if (isIconName(value.icon)) out.icon = value.icon;
  const border = choice(RULE_BORDERS, value.border);
  if (border !== undefined) out.border = border;
  const label = text(value.label);
  if (label !== "") out.label = label;
  const badge = text(value.badge);
  if (badge !== "") out.badge = badge;
  return out;
}

function parseEdgeTargets(stored: unknown): EdgeTargets {
  const value = isRecord(stored) ? stored : {};
  const out: EdgeTargets = {};
  const color = choice(STYLE_COLORS, value.color);
  if (color !== undefined) out.color = color;
  const width = clampInt(value.width, RULE_WIDTH.min, RULE_WIDTH.max);
  if (width !== undefined) out.width = width;
  const dash = choice(EDGE_DASHES, value.dash);
  if (dash !== undefined) out.dash = dash;
  const label = text(value.label);
  if (label !== "") out.label = label;
  const arrow = choice(EDGE_ARROWS, value.arrow);
  if (arrow !== undefined) out.arrow = arrow;
  return out;
}

const RULE_ID = /^[A-Za-z0-9_-]{1,24}$/;

function parseRules<T>(
  stored: unknown,
  targets: (stored: unknown) => T,
  room: number,
  taken: Set<string>,
): StyleRule<T>[] {
  const out: StyleRule<T>[] = [];
  for (const entry of Array.isArray(stored) ? stored : []) {
    if (out.length >= room) break;
    if (!isRecord(entry)) continue;
    const when = parseWhen(entry.when);
    if (when === null) continue;
    let id = typeof entry.id === "string" && RULE_ID.test(entry.id) ? entry.id : "";
    // A missing or repeated id (rules written by hand) gets one of its own.
    for (let n = taken.size + 1; id === "" || taken.has(id); n++) id = `r${n}`;
    taken.add(id);
    out.push({
      id,
      on: entry.on !== false,
      scope: text(entry.scope),
      when,
      set: targets(entry.set),
    });
  }
  return out;
}

/** The rules this build can read of a stored style, whatever version it names. */
function readRules(stored: Record<string, unknown>): GraphStyle {
  const taken = new Set<string>();
  const nodes = parseRules(stored.nodes, parseNodeTargets, MAX_STYLE_RULES, taken);
  const edges = parseRules(stored.edges, parseEdgeTargets, MAX_STYLE_RULES - nodes.length, taken);
  if (nodes.length === 0 && edges.length === 0) return EMPTY_STYLE;
  return { version: STYLE_VERSION, nodes, edges };
}

/**
 * The style a panel stores. Options from before the rules existed carry no `style` and read as
 * no rules: their color by label or property, size and shape per label are the basis and stay
 * exactly where they are (the panel's other options), so nothing is lost. Rules beyond the
 * limit, and rules or targets that do not parse, are dropped. A style of a newer version than
 * this build knows is kept exactly as stored, never rewritten in the older form: it is drawn as
 * far as it can be read (`readableStyle`) and not edited (`isNewerStyle`).
 */
export function parseGraphStyle(stored: unknown): GraphStyle {
  if (!isRecord(stored)) return EMPTY_STYLE;
  if (typeof stored.version === "number" && stored.version > STYLE_VERSION) {
    return stored as unknown as GraphStyle;
  }
  return readRules(stored);
}

/** Whether a style comes from a newer version of Kalzit than this one. */
export function isNewerStyle(style: GraphStyle): boolean {
  return style.version > STYLE_VERSION;
}

/** A style as this build draws it: a newer one as far as its rules can be read. */
export function readableStyle(style: GraphStyle): GraphStyle {
  return isNewerStyle(style) ? readRules(style as unknown as Record<string, unknown>) : style;
}

/** The rules of a style, of both kinds. */
export function ruleCount(style: GraphStyle): number {
  return style.nodes.length + style.edges.length;
}

/** An id no rule of the style has. */
export function newRuleId(style: GraphStyle): string {
  const taken = new Set([...style.nodes, ...style.edges].map((rule) => rule.id));
  for (let n = taken.size + 1; ; n++) {
    const id = `r${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Another panel's rules as this panel's own ("take over rules from another panel"): a copy with
 * ids of its own, nothing linked, so a panel never changes another one silently.
 */
export function copyStyle(from: GraphStyle): GraphStyle {
  return parseGraphStyle(JSON.parse(JSON.stringify(from)));
}

/** Whether a rule sets anything at all (a rule "per unique value" sets the color). */
export function setsSomething(rule: StyleRule<NodeTargets | EdgeTargets>): boolean {
  return rule.when.kind === "values" || Object.keys(rule.set).length > 0;
}
