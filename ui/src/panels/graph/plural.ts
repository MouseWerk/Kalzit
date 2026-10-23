import type { Language, MessageKey, Translate } from "../../i18n/i18n";

/** Counted nouns of the graph panels, with a message per plural category the languages use. */
const NOUNS = {
  node: { one: "graph.count.node.one", other: "graph.count.node.other" },
  edge: { one: "graph.count.edge.one", other: "graph.count.edge.other" },
  component: { one: "graph.count.component.one", other: "graph.count.component.other" },
  community: { one: "graph.count.community.one", other: "graph.count.community.other" },
} as const satisfies Record<string, Record<"one" | "other", MessageKey>>;

export type CountedNoun = keyof typeof NOUNS;

const rules = new Map<string, Intl.PluralRules>();

/** "1 node", "3 nodes": the count formatted for the language, with the matching form. */
export function countText(
  t: Translate,
  language: Language,
  noun: CountedNoun,
  count: number,
): string {
  let rule = rules.get(language);
  if (rule === undefined) {
    rule = new Intl.PluralRules(language);
    rules.set(language, rule);
  }
  const forms = NOUNS[noun];
  const key = rule.select(count) === "one" ? forms.one : forms.other;
  return t(key, { count: new Intl.NumberFormat(language).format(count) });
}
