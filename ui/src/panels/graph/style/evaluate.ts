import { isRecord } from "../../../api/client";
import { clipChars } from "../../../lib/chars";
import { propertyText, readNumber, readTime } from "../adapter";
import {
  type Condition,
  type EdgeTargets,
  MAX_BADGE_CHARS,
  MAX_RULE_TEXT,
  MAX_STYLE_RULES,
  MAX_VALUE_COLORS,
  type NodeTargets,
  PALETTE_COLORS,
  type StyleColor,
  type StyleRule,
} from "./schema";

/**
 * The style rules evaluated on data, as pure functions: no renderer, no panel, no clock but the
 * one handed in. The graph panel, tables made from a graph and the map all read the same answer,
 * so a rule colors the same nodes everywhere.
 *
 * Rules apply from top to bottom. Each rule that matches an item sets its targets on it; where
 * two rules set the same target, the lower one wins (general rules above, exceptions below).
 */

/** What a rule is evaluated on: a node with its labels, or an edge with its type. */
export interface StyleItem {
  /** A node's labels, or an edge's type as the only entry. */
  kinds: readonly string[];
  properties: Readonly<Record<string, unknown>>;
}

/** Every target a rule can set, of nodes and of edges. */
export type Targets = NodeTargets & EdgeTargets;
export type TargetKey = keyof Targets;

/** What the rules make of one item. Templates (`label`, `badge`) are filled in. */
export interface ItemStyle {
  set: Targets;
  /** The rule (its index) each target comes from. */
  from: Partial<Record<TargetKey, number>>;
  /** Every rule that matched the item, top to bottom. */
  rules: number[];
  /**
   * The color is one the palette hands out a second time (the ninth to twelfth value of a rule
   * "per unique value"): the item takes another shape, so the two values stay apart.
   */
  shifted: boolean;
}

/** One value of a rule "per unique value", with the color it takes. */
export interface ValueSlot {
  value: string;
  /** Items with the value. */
  count: number;
  color: StyleColor;
  /** The palette's second round (see `ItemStyle.shifted`). */
  shifted: boolean;
}

/** The honest count of a rule "per unique value": N of M values carry a color. */
export interface ValuesReport {
  /** The values with a color of their own, in the order of their slots. */
  shown: ValueSlot[];
  /** Distinct values among the items the rule is for. */
  total: number;
  /** The values beyond the colored ones, which share the neutral color. */
  other: { values: number; count: number };
  /** Items without a value: they keep the basis. */
  missing: number;
}

export type RuleState =
  /** Switched off: it stays in the list and changes nothing. */
  | "off"
  /** Its property occurs nowhere in the result: it rests instead of failing the panel. */
  | "dormant"
  /** Its condition's value does not fit the data type (a word where a number belongs). */
  | "invalid"
  | "active";

export interface RuleReport {
  state: RuleState;
  /** Items of the rule's label or type. */
  inScope: number;
  /** Items the rule applies to. */
  matched: number;
  /** Rules below that took a target from this one, with the items it lost it on. */
  overridden: { by: number; count: number }[];
  values: ValuesReport | null;
}

export interface Evaluation {
  /** Per item, in the order given; null where no rule applies (the basis alone). */
  styles: (ItemStyle | null)[];
  /** Per rule, in the order given. */
  rules: RuleReport[];
}

export interface EvaluateOptions {
  /** Unix ms; "in the last N days" counts from here. */
  now?: number;
}

const DAY_MS = 86_400_000;

/** Whether a property has a value: present, not null and not empty text. */
export function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return propertyText(value) !== "";
}

/** A condition's number as typed: decimal, with a point or a comma. */
export function parseConditionNumber(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

/**
 * A condition's date as typed: a day (`2022-01-01`, which stands for the whole day in UTC) or a
 * point in time (`2022-01-01T08:30:00Z`). `end` is where the day ends, or the same instant.
 */
export function parseConditionDate(text: string): { start: number; end: number } | null {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const start = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isFinite(start) ? { start, end: start + DAY_MS } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? { start: at, end: at } : null;
}

/** Whether a condition's values fit its data type; a rule that does not is "invalid". */
export function conditionProblem(condition: Condition): "value" | "to" | null {
  const { type, op } = condition;
  if (op === "exists" || op === "missing" || type === "boolean") return null;
  const good = (value: string): boolean => {
    if (type === "number") return parseConditionNumber(value) !== null;
    if (type === "date") {
      if (op === "lastDays") {
        const days = parseConditionNumber(value);
        return days !== null && days >= 0;
      }
      return parseConditionDate(value) !== null;
    }
    return value !== "";
  };
  if (!good(condition.value)) return "value";
  return op === "between" && !good(condition.to) ? "to" : null;
}

type Predicate = (value: unknown) => boolean;

/** Text as a rule compares it: a list is compared element by element. */
function textsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(propertyText);
  if (isRecord(value) && typeof value.$type !== "string") return [];
  return [propertyText(value)];
}

/** The test a condition makes of one property value; null when its own values do not fit. */
function predicate(condition: Condition, now: number): Predicate | null {
  const { type, op } = condition;
  if (op === "exists") return hasValue;
  if (op === "missing") return (value) => !hasValue(value);
  if (conditionProblem(condition) !== null) return null;
  if (type === "boolean") {
    const wanted = op === "true";
    return (value) => value === wanted;
  }
  if (type === "number") {
    const a = parseConditionNumber(condition.value) ?? 0;
    const b = parseConditionNumber(condition.to) ?? 0;
    const test = (n: number): boolean => {
      switch (op) {
        case "eq":
          return n === a;
        case "ne":
          return n !== a;
        case "lt":
          return n < a;
        case "lte":
          return n <= a;
        case "gt":
          return n > a;
        case "gte":
          return n >= a;
        case "between":
          return n >= Math.min(a, b) && n <= Math.max(a, b);
        default:
          return false;
      }
    };
    return (value) => {
      const n = readNumber(value);
      return n !== null && test(n);
    };
  }
  if (type === "date") {
    if (op === "lastDays") {
      const from = now - (parseConditionNumber(condition.value) ?? 0) * DAY_MS;
      return (value) => {
        const t = readTime(value);
        return t !== null && t >= from && t <= now;
      };
    }
    const a = parseConditionDate(condition.value) ?? { start: 0, end: 0 };
    const b = parseConditionDate(condition.to) ?? a;
    return (value) => {
      const t = readTime(value);
      if (t === null) return false;
      switch (op) {
        case "on":
          return a.end > a.start ? t >= a.start && t < a.end : t === a.start;
        case "before":
          return t < a.start;
        case "after":
          return a.end > a.start ? t >= a.end : t > a.start;
        case "between": {
          // From the earlier value to the later one; a day as the later value counts whole.
          const [low, high] = a.start <= b.start ? [a, b] : [b, a];
          return t >= low.start && (high.end > high.start ? t < high.end : t <= high.end);
        }
        default:
          return false;
      }
    };
  }
  // Text: without case unless the rule asks for it; of a list, one element is enough.
  const fold = (s: string) => (condition.caseSensitive ? s : s.toLowerCase());
  const wanted = fold(condition.value);
  const test = (s: string): boolean => {
    switch (op) {
      case "eq":
        return s === wanted;
      case "contains":
        return s.includes(wanted);
      case "startsWith":
        return s.startsWith(wanted);
      default:
        return false;
    }
  };
  return (value) => {
    if (!hasValue(value)) return false;
    const texts = textsOf(value).map(fold);
    // Of a list and of nested values, only "contains" (an element of the list) can be asked.
    if (Array.isArray(value)) return op === "contains" && texts.includes(wanted);
    if (op === "ne") return !texts.some((s) => s === wanted);
    if (op === "notContains") return !texts.some((s) => s.includes(wanted));
    return texts.some(test);
  };
}

/** A template with `{property}` filled in from the item; a property it lacks leaves nothing. */
export function fillTemplate(
  template: string,
  properties: Readonly<Record<string, unknown>>,
  max = MAX_RULE_TEXT,
): string {
  const filled = template.replace(/\{([^{}]+)\}/g, (_, key: string) =>
    Object.hasOwn(properties, key) ? propertyText(properties[key]) : "",
  );
  return clipChars(filled.replace(/\s+/g, " ").trim(), max);
}

function inScope(item: StyleItem, scope: string): boolean {
  return scope === "" || item.kinds.includes(scope);
}

/** Text in a fixed order (UTF-16 code units), so the same data always colors the same values. */
function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The slots of a rule "per unique value": the values the rule names keep their colors (and their
 * place, also while the result lacks them), then the most frequent other values take the
 * palette's colors in order, up to MAX_VALUE_COLORS in all. From the ninth slot on the palette
 * repeats, marked `shifted`.
 */
export function valueSlots(
  pinned: readonly { value: string; color: StyleColor }[],
  counts: ReadonlyMap<string, number>,
): ValueSlot[] {
  const slots: ValueSlot[] = pinned.slice(0, MAX_VALUE_COLORS).map(({ value, color }, i) => ({
    value,
    color,
    count: counts.get(value) ?? 0,
    shifted: i >= PALETTE_COLORS.length,
  }));
  const taken = new Set(slots.map((slot) => slot.value));
  const rest = [...counts]
    .filter(([value]) => !taken.has(value))
    .sort((a, b) => b[1] - a[1] || textOrder(a[0], b[0]));
  for (const [value, count] of rest) {
    if (slots.length >= MAX_VALUE_COLORS) break;
    const i = slots.length;
    slots.push({
      value,
      count,
      color: PALETTE_COLORS[i % PALETTE_COLORS.length] as StyleColor,
      shifted: i >= PALETTE_COLORS.length,
    });
  }
  return slots;
}

/**
 * Evaluates `rules` on `items`. The answer has a style per item (null where only the basis
 * applies) and a report per rule: how many items it is for and matches, whether it rests, what
 * rules below took from it, and for "per unique value" the N of M values that carry a color.
 */
export function evaluateRules(
  rules: readonly StyleRule<Targets>[],
  items: readonly StyleItem[],
  options: EvaluateOptions = {},
): Evaluation {
  const now = options.now ?? Date.now();
  const used = rules.slice(0, MAX_STYLE_RULES);
  const styles: (ItemStyle | null)[] = new Array(items.length).fill(null);
  const reports: RuleReport[] = [];
  // Per rule: the items it set each target on, to say later what was taken from it.
  const wrote: { item: number; key: TargetKey }[][] = [];

  const apply = (item: number, rule: number, set: Targets, shifted = false) => {
    let style = styles[item];
    if (style === null || style === undefined) {
      style = { set: {}, from: {}, rules: [], shifted: false };
      styles[item] = style;
    }
    style.rules.push(rule);
    for (const key of Object.keys(set) as TargetKey[]) {
      (style.set as Record<string, unknown>)[key] = set[key];
      style.from[key] = rule;
      if (key === "color") style.shifted = shifted;
      (wrote[rule] as { item: number; key: TargetKey }[]).push({ item, key });
    }
  };

  used.forEach((rule, r) => {
    wrote.push([]);
    const report: RuleReport = {
      state: rule.on ? "active" : "off",
      inScope: 0,
      matched: 0,
      overridden: [],
      values: null,
    };
    reports.push(report);
    const scoped: number[] = [];
    items.forEach((item, i) => {
      if (inScope(item, rule.scope)) scoped.push(i);
    });
    report.inScope = scoped.length;
    const when = rule.when;
    const property = when.kind === "always" ? null : when.property;
    const present =
      property === null ||
      scoped.some((i) => Object.hasOwn((items[i] as StyleItem).properties, property));

    if (when.kind === "values") {
      const counts = new Map<string, number>();
      const texts: string[] = [];
      let missing = 0;
      for (const i of scoped) {
        const value = (items[i] as StyleItem).properties[when.property];
        const text = hasValue(value) ? propertyText(value) : "";
        texts.push(text);
        if (text === "") missing++;
        else counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      const slots = valueSlots(when.colors, counts);
      const slotOf = new Map(slots.map((slot) => [slot.value, slot]));
      let otherCount = 0;
      for (const [value, count] of counts) if (!slotOf.has(value)) otherCount += count;
      report.values = {
        shown: slots,
        total: counts.size,
        other: {
          values: [...counts.keys()].filter((value) => !slotOf.has(value)).length,
          count: otherCount,
        },
        missing,
      };
      report.matched = scoped.length - missing;
      if (!rule.on) return;
      if (!present) {
        report.state = "dormant";
        return;
      }
      scoped.forEach((i, at) => {
        const text = texts[at] as string;
        if (text === "") return;
        const slot = slotOf.get(text);
        // Values beyond the colored ones share the neutral color; items without a value keep
        // the basis.
        apply(i, r, { color: slot?.color ?? "neutral" }, slot?.shifted ?? false);
      });
      return;
    }

    let test: Predicate | null = () => true;
    if (when.kind === "condition") {
      test = predicate(when, now);
      if (test === null) {
        if (rule.on) report.state = "invalid";
        return;
      }
    }
    const hits: number[] = [];
    for (const i of scoped) {
      const item = items[i] as StyleItem;
      if (property === null || test(item.properties[property])) hits.push(i);
    }
    report.matched = hits.length;
    if (!rule.on) return;
    // "Is missing" matches exactly the items without the property, so it never rests.
    const asksForAbsence = when.kind === "condition" && when.op === "missing";
    if (!present && !asksForAbsence) {
      report.state = "dormant";
      return;
    }
    for (const i of hits) {
      const item = items[i] as StyleItem;
      const set: Targets = { ...rule.set };
      if (set.label !== undefined) {
        const label = fillTemplate(set.label, item.properties);
        if (label === "") delete set.label;
        else set.label = label;
      }
      if (set.badge !== undefined) {
        const badge = fillTemplate(set.badge, item.properties, MAX_BADGE_CHARS);
        if (badge === "") delete set.badge;
        else set.badge = badge;
      }
      apply(i, r, set);
    }
  });

  // What a rule set and a lower rule set again, per item once and by the rule that won.
  used.forEach((_, r) => {
    const lost = new Map<number, Set<number>>();
    for (const { item, key } of wrote[r] as { item: number; key: TargetKey }[]) {
      const winner = styles[item]?.from[key];
      if (winner !== undefined && winner !== r) {
        const items = lost.get(winner) ?? new Set<number>();
        items.add(item);
        lost.set(winner, items);
      }
    }
    (reports[r] as RuleReport).overridden = [...lost]
      .map(([by, set]) => ({ by, count: set.size }))
      .sort((a, b) => a.by - b.by);
  });

  return { styles, rules: reports };
}

/**
 * The data type a property most likely has among the items a rule is for, so a new condition
 * starts with the comparisons that fit: the first value present decides.
 */
export function guessType(
  items: readonly StyleItem[],
  property: string,
  scope = "",
): "number" | "text" | "date" | "boolean" {
  for (const item of items) {
    if (!inScope(item, scope)) continue;
    const value = item.properties[property];
    if (!hasValue(value)) continue;
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (isRecord(value) && typeof value.$type === "string") {
      if (value.$type === "int64" || value.$type === "decimal") return "number";
      if (/date|time/i.test(value.$type)) return "date";
      return "text";
    }
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && readTime(value) !== null) {
      return "date";
    }
    return "text";
  }
  return "text";
}
