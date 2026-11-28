import type {
  Condition,
  Operator,
  ParameterType,
  Pattern,
  PatternEdge,
  PatternNode,
} from "../../api/generated/shapes";
import type { Language, MessageKey, Translate } from "../../i18n/i18n";
import { DEFAULT_LIMIT, edgesOf, elementOrder, nodeById, valueText } from "./pattern";

/*
 * The pattern in plain language (board Graph083, frame 1: "Satz"), built from its labels, types
 * and conditions. It says what the drawing says, nothing the server would add.
 */

export const OPERATOR_TEXT: Record<Operator, MessageKey> = {
  eq: "graphPatterns.opText.eq",
  ne: "graphPatterns.opText.ne",
  lt: "graphPatterns.opText.lt",
  le: "graphPatterns.opText.le",
  gt: "graphPatterns.opText.gt",
  ge: "graphPatterns.opText.ge",
  contains: "graphPatterns.opText.contains",
  startsWith: "graphPatterns.opText.startsWith",
  endsWith: "graphPatterns.opText.endsWith",
  in: "graphPatterns.opText.in",
  isNull: "graphPatterns.opText.isNull",
  isNotNull: "graphPatterns.opText.isNotNull",
};

export const TYPE_TEXT: Record<ParameterType, MessageKey> = {
  string: "graphPatterns.type.string",
  integer: "graphPatterns.type.integer",
  float: "graphPatterns.type.float",
  boolean: "graphPatterns.type.boolean",
  stringList: "graphPatterns.type.stringList",
  integerList: "graphPatterns.type.integerList",
  floatList: "graphPatterns.type.floatList",
  idList: "graphPatterns.type.idList",
};

function list(language: Language, items: string[], type: "conjunction" | "disjunction"): string {
  return new Intl.ListFormat(language, { type }).format(items);
}

/** "Kunde k", "Kunde oder Lieferant x", "any node n". */
export function nodePhrase(t: Translate, language: Language, node: PatternNode): string {
  const labels = node.labels ?? [];
  if (labels.length === 0) return t("graphPatterns.sentence.anyNode", { id: node.id });
  return t("graphPatterns.sentence.node", {
    labels: list(language, labels, "disjunction"),
    id: node.id,
  });
}

export function conditionPhrase(t: Translate, condition: Condition): string {
  const op = t(OPERATOR_TEXT[condition.op]);
  if (condition.value === undefined) {
    return t("graphPatterns.sentence.conditionNoValue", { property: condition.property, op });
  }
  const value = valueText(condition.value);
  return t("graphPatterns.sentence.condition", {
    property: condition.property,
    op,
    value,
  });
}

function edgePhrase(t: Translate, language: Language, edge: PatternEdge): string {
  const types =
    (edge.types ?? []).length === 0
      ? t("graphPatterns.sentence.anyType")
      : list(language, edge.types ?? [], "disjunction");
  const from = edge.from;
  const to = edge.to;
  const path =
    (edge.maxHops ?? 1) > 1
      ? ` ${t("graphPatterns.sentence.hops", { min: edge.minHops ?? 1, max: edge.maxHops ?? 1 })}`
      : "";
  const key: MessageKey =
    edge.direction === "both"
      ? "graphPatterns.sentence.edgeBoth"
      : "graphPatterns.sentence.edgeOut";
  const [a, b] = edge.direction === "in" ? [to, from] : [from, to];
  const text = `${t(key, { from: a, to: b, types })}${path}`;
  return edge.optional === true ? t("graphPatterns.sentence.optional", { part: text }) : text;
}

/** The whole sentence, one short sentence per part, ending with the limit. */
export function patternSentence(t: Translate, language: Language, pattern: Pattern): string {
  if (pattern.nodes.length === 0) return "";
  const parts: string[] = [];
  const order = elementOrder(pattern);
  const nodes = order
    .filter((o) => o.kind === "node")
    .map((o) => nodeById(pattern, o.id))
    .filter((n): n is PatternNode => n !== undefined)
    .map((n) => nodePhrase(t, language, n));
  parts.push(t("graphPatterns.sentence.find", { nodes: list(language, nodes, "conjunction") }));
  for (const edge of edgesOf(pattern)) {
    parts.push(`${edgePhrase(t, language, edge)}.`);
  }
  const owners: { id: string; conditions: Condition[]; any: boolean }[] = [
    ...pattern.nodes.map((n) => ({
      id: n.id,
      conditions: n.conditions ?? [],
      any: n.matches === "any",
    })),
    ...edgesOf(pattern).map((e) => ({
      id: e.id,
      conditions: e.conditions ?? [],
      any: e.matches === "any",
    })),
  ];
  for (const owner of owners) {
    if (owner.conditions.length === 0) continue;
    const text = list(
      language,
      owner.conditions.map((c) => conditionPhrase(t, c)),
      owner.any ? "disjunction" : "conjunction",
    );
    parts.push(t("graphPatterns.sentence.where", { id: owner.id, conditions: text }));
  }
  parts.push(
    t("graphPatterns.sentence.limit", {
      limit: (pattern.limit ?? DEFAULT_LIMIT).toLocaleString(language),
    }),
  );
  return parts.join(" ");
}
