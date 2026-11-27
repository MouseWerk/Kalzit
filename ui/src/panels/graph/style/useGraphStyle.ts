import { useMemo } from "react";
import type { GraphModel } from "../model";
import type { GraphView } from "../view";
import { evaluateStyle, type GraphEvaluation, type StyledView, styleView } from "./apply";
import type { GraphStyle } from "./schema";

/**
 * A graph panel's style rules on its model and view: the evaluation (per model node and edge,
 * with a report per rule) and what the drawing makes of it (per view node and edge). Both are
 * null without rules, so a panel without them draws exactly as before.
 */
export function useGraphStyle(
  model: Pick<GraphModel, "nodes" | "edges">,
  view: GraphView,
  style: GraphStyle,
): { evaluation: GraphEvaluation | null; styled: StyledView | null } {
  const evaluation = useMemo(() => evaluateStyle(model, style), [model, style]);
  const styled = useMemo(
    () => (evaluation === null ? null : styleView(view, evaluation)),
    [view, evaluation],
  );
  return { evaluation, styled };
}

/** The node labels and edge types of a model, and the property keys of each, for the editor. */
export interface StyleVocabulary {
  labels: string[];
  edgeTypes: string[];
  /** Property keys per label ("" for every node) and per edge type ("" for every edge). */
  nodeKeys: Map<string, string[]>;
  edgeKeys: Map<string, string[]>;
}

export function vocabularyOf(model: {
  nodes: readonly { labels: readonly string[]; properties: Readonly<Record<string, unknown>> }[];
  edges: readonly { type: string; properties: Readonly<Record<string, unknown>> }[];
}): StyleVocabulary {
  const nodeKeys = new Map<string, Set<string>>([["", new Set()]]);
  const edgeKeys = new Map<string, Set<string>>([["", new Set()]]);
  const add = (map: Map<string, Set<string>>, kind: string, keys: string[]) => {
    const own = map.get(kind) ?? new Set<string>();
    const all = map.get("") as Set<string>;
    for (const key of keys) {
      own.add(key);
      all.add(key);
    }
    map.set(kind, own);
  };
  for (const node of model.nodes) {
    const keys = Object.keys(node.properties);
    for (const label of node.labels) add(nodeKeys, label, keys);
    if (node.labels.length === 0) add(nodeKeys, "", keys);
  }
  for (const edge of model.edges) add(edgeKeys, edge.type, Object.keys(edge.properties));
  const sorted = (map: Map<string, Set<string>>) =>
    new Map([...map].map(([kind, keys]) => [kind, [...keys].sort()]));
  return {
    labels: [...nodeKeys.keys()].filter((label) => label !== "").sort(),
    edgeTypes: [...edgeKeys.keys()].filter((type) => type !== "").sort(),
    nodeKeys: sorted(nodeKeys),
    edgeKeys: sorted(edgeKeys),
  };
}
