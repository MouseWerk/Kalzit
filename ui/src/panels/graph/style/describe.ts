import type { MessageKey, Translate } from "../../../i18n/i18n";
import type { RuleReport } from "./evaluate";
import {
  type ConditionOp,
  type EdgeTargets,
  type NodeTargets,
  operands,
  type RuleWhen,
  type StyleColor,
  type StyleRule,
  type ValueType,
} from "./schema";

/**
 * A rule in words, as the list, the legend and the table view read it: when, for which label
 * or edge type, then what (Graph081 board, frame 8: "Jede Regel liest sich als Satz").
 */

export type RuleKind = "nodes" | "edges";

/** The words of a comparison; a range reads differently for numbers and for dates. */
export function opText(t: Translate, type: ValueType, op: ConditionOp): string {
  if (op === "between") {
    return t(type === "date" ? "graphStyle.op.dateBetween" : "graphStyle.op.between");
  }
  return t(`graphStyle.op.${op}` as MessageKey);
}

export function colorText(t: Translate, color: StyleColor): string {
  return t(`graphStyle.color.${color}` as MessageKey);
}

/** "Wenn umsatz größer oder gleich 10000", "Je Wert von segment", "Immer". */
export function whenText(t: Translate, when: RuleWhen): string {
  if (when.kind === "always") return t("graphStyle.when.always");
  if (when.kind === "values") return t("graphStyle.when.values", { property: when.property });
  const op = opText(t, when.type, when.op);
  const count = operands(when.op);
  if (count === 0) return t("graphStyle.when.test", { property: when.property, op });
  if (when.op === "lastDays") {
    return t("graphStyle.when.lastDays", { property: when.property, days: when.value });
  }
  if (count === 2) {
    return t(when.type === "date" ? "graphStyle.when.dateRange" : "graphStyle.when.range", {
      property: when.property,
      value: when.value,
      to: when.to,
    });
  }
  return t("graphStyle.when.compare", { property: when.property, op, value: when.value });
}

/** The label or edge type a rule is for, or "all" of its kind. */
export function scopeText(t: Translate, scope: string, kind: RuleKind): string {
  if (scope !== "") return scope;
  return t(kind === "nodes" ? "graphStyle.scope.allNodes" : "graphStyle.scope.allEdges");
}

/** One target with its value: "Icon user", "Abzeichen „Top“", "Breite 3". */
export function targetText(
  t: Translate,
  key: keyof NodeTargets | keyof EdgeTargets,
  value: unknown,
): string {
  const name = t(`graphStyle.target.${key}` as MessageKey);
  switch (key) {
    case "color":
      return `${name} ${colorText(t, value as StyleColor)}`;
    case "shape":
      return `${name} ${t(`graphStyle.shape.${value as string}` as MessageKey)}`;
    case "border":
      return `${name} ${t(`graphStyle.border.${value as string}` as MessageKey)}`;
    case "dash":
      return `${name} ${t(`graphStyle.dash.${value as string}` as MessageKey)}`;
    case "arrow":
      return `${name} ${t(`graphStyle.arrow.${value as string}` as MessageKey)}`;
    case "label":
    case "badge":
      return t("graphStyle.quoted", { name, text: String(value) });
    default:
      return `${name} ${String(value)}`;
  }
}

/** What a rule sets, in words; a rule "per unique value" sets the color from its values. */
export function thenText(t: Translate, rule: StyleRule<NodeTargets | EdgeTargets>): string {
  const parts: string[] = [];
  if (rule.when.kind === "values") parts.push(t("graphStyle.target.colorPerValue"));
  for (const [key, value] of Object.entries(rule.set)) {
    if (value === undefined) continue;
    parts.push(targetText(t, key as keyof NodeTargets, value));
  }
  return parts.length === 0 ? t("graphStyle.nothingSet") : parts.join(", ");
}

/** The whole sentence: "Wenn umsatz größer oder gleich 10000 (Kunde), dann Abzeichen „Top“". */
export function ruleSentence(
  t: Translate,
  rule: StyleRule<NodeTargets | EdgeTargets>,
  kind: RuleKind,
): string {
  return t("graphStyle.sentence", {
    when: whenText(t, rule.when),
    scope: scopeText(t, rule.scope, kind),
    effect: thenText(t, rule),
  });
}

/** The state of a rule in the current result, in words ("trifft 2", "ruht: ..."). */
export function reportText(
  t: Translate,
  rule: StyleRule<NodeTargets | EdgeTargets>,
  report: RuleReport | undefined,
  format: (n: number) => string,
): string {
  if (!rule.on) return t("graphStyle.state.off");
  if (report === undefined) return "";
  if (report.state === "dormant" && rule.when.kind !== "always") {
    return t("graphStyle.state.dormant", { property: rule.when.property });
  }
  if (report.state === "invalid") return t("graphStyle.state.invalid");
  if (report.values !== null) {
    return t("graphStyle.values.count", {
      shown: format(report.values.shown.filter((slot) => slot.count > 0).length),
      total: format(report.values.total),
    });
  }
  return t("graphStyle.state.matches", { count: format(report.matched) });
}
