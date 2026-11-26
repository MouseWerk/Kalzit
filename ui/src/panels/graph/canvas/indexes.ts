import type { GraphModel } from "../model";
import type { PinnedNodes } from "../pinned";
import type { GraphView } from "../view";
import type { Place } from "./edits";

/**
 * Between what is kept (node and edge ids, which outlive a result) and what is drawn (view
 * indexes, which change with every view). Pure, so it is tested without a panel.
 */

/** The view index that draws exactly this node (not the group it is in); null otherwise. */
export function nodeIndexOf(model: GraphModel, view: GraphView, id: string): number | null {
  const m = model.index.get(id);
  if (m === undefined) return null;
  const at = view.nodeOf[m] ?? -1;
  return at >= 0 && view.nodes[at]?.node === m ? at : null;
}

/** Model edge index by edge id. */
export function edgeIndex(model: GraphModel): Map<string, number> {
  return new Map(model.edges.map((edge, i) => [edge.id, i]));
}

/** The node ids a view node stands for: the node itself, or every member of a group. */
export function idsOf(model: GraphModel, view: GraphView, index: number): string[] {
  const node = view.nodes[index];
  if (node === undefined) return [];
  if (node.node >= 0) return [model.nodes[node.node]?.id ?? ""].filter((id) => id !== "");
  const out: string[] = [];
  view.nodeOf.forEach((at, m) => {
    if (at === index) out.push(model.nodes[m]?.id ?? "");
  });
  return out.filter((id) => id !== "");
}

/** The edge id a view edge draws; null for an edge that stands for many (between groups). */
export function edgeIdOf(model: GraphModel, view: GraphView, index: number): string | null {
  const edge = view.edges[index];
  if (edge === undefined || edge.edge < 0) return null;
  return model.edges[edge.edge]?.id ?? null;
}

/**
 * The hidden nodes and edges by view index. A group whose members are all hidden is hidden; a
 * group with some hidden members stays.
 */
export function hiddenIndexes(
  model: GraphModel,
  view: GraphView,
  hidden: readonly string[],
  hiddenEdges: readonly string[],
): { nodes: Set<number>; edges: Set<number> } {
  const nodes = new Set<number>();
  const edges = new Set<number>();
  if (hidden.length > 0) {
    const gone = new Set(hidden);
    const members = new Map<number, { all: number; gone: number }>();
    model.nodes.forEach((node, m) => {
      const at = view.nodeOf[m] ?? -1;
      if (at < 0) return;
      const count = members.get(at) ?? { all: 0, gone: 0 };
      count.all++;
      if (gone.has(node.id)) count.gone++;
      members.set(at, count);
    });
    for (const [at, count] of members)
      if (count.gone > 0 && count.gone === count.all) nodes.add(at);
  }
  if (hiddenEdges.length > 0) {
    const byId = edgeIndex(model);
    for (const id of hiddenEdges) {
      const m = byId.get(id);
      const at = m === undefined ? -1 : (view.edgeOf[m] ?? -1);
      if (at >= 0) edges.add(at);
    }
  }
  return { nodes, edges };
}

/** Pinned nodes with a place, by the view index that draws them (groups are never pinned). */
export function fixedIndexes(
  model: GraphModel,
  view: GraphView,
  places: ReadonlyMap<string, Place>,
): Map<number, Place> {
  const out = new Map<number, Place>();
  for (const [id, at] of places) {
    const index = nodeIndexOf(model, view, id);
    if (index !== null) out.set(index, at);
  }
  return out;
}

/**
 * The pinned nodes as the layouts read them (pinned.ts): every pinned node with a place, by node
 * id, in the drawing's own units, and the way to release them all.
 */
export function pinnedForLayouts(
  places: ReadonlyMap<string, Place>,
  release: (() => void) | undefined,
): PinnedNodes {
  return release === undefined || places.size === 0
    ? { positions: places }
    : { positions: places, release };
}
