import type { GraphExportScope } from "../../../api/generated/shapes";
import type { GraphModel } from "../model";
import type { GraphView, Visibility } from "../view";
import type { Scene } from "./scene";

/**
 * Which part of the graph a file or a picture holds, counted and named in the graph's own nodes:
 * a group of nodes the panel draws as one (a cluster) stands for all of its nodes.
 */

/** The most positions a request carries (the server's bound); beyond it GraphML goes without. */
export const MAX_POSITIONS = 50_000;

export type DataScope = "loaded" | "visible" | "selection";

export interface ScopeCounts {
  /** Nodes the panel has loaded. */
  total: number;
  /** Nodes that are not hidden (by the legend, the time slider or "only the selection"). */
  visible: number;
  /** Visible nodes that are selected. */
  selected: number;
  /** Edges between visible nodes, as the model counts them. */
  edges: number;
}

export function scopeCounts(
  model: GraphModel,
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
): ScopeCounts {
  let visible = 0;
  let picked = 0;
  view.nodes.forEach((node, i) => {
    if (visibility.nodes[i] !== 1) return;
    visible += node.members;
    if (selected.has(i)) picked += node.members;
  });
  let edges = 0;
  view.edges.forEach((edge, i) => {
    if (visibility.edges[i] === 1) edges += edge.count;
  });
  return { total: model.nodes.length, visible, selected: picked, edges };
}

export interface DataCounts {
  /** Nodes of the panel's own result, counted as `ScopeCounts` counts them. */
  total: number;
  visible: number;
  selected: number;
  /** Nodes the explorer added (or pins kept from it): the server's file never holds them. */
  explorer: { total: number; visible: number; selected: number };
}

/**
 * The counts of a data export. The server makes the file from the panel's stored query, so only
 * nodes of that result count; the explorer's nodes are counted apart. Without `own` every node
 * is the panel's own.
 */
export function dataCounts(
  model: GraphModel,
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
  own?: ReadonlySet<string>,
): DataCounts {
  const counts: DataCounts = {
    total: 0,
    visible: 0,
    selected: 0,
    explorer: { total: 0, visible: 0, selected: 0 },
  };
  model.nodes.forEach((node, i) => {
    const bucket = own === undefined || own.has(node.id) ? counts : counts.explorer;
    bucket.total++;
    const at = view.nodeOf[i];
    if (at === undefined || at < 0 || visibility.nodes[at] !== 1) return;
    bucket.visible++;
    if (selected.has(at)) bucket.selected++;
  });
  return counts;
}

/** The ids of the model nodes behind the view nodes that pass. */
function idsWhere(
  model: GraphModel,
  view: GraphView,
  pass: (viewNode: number) => boolean,
): string[] {
  const ids: string[] = [];
  model.nodes.forEach((node, i) => {
    const at = view.nodeOf[i];
    if (at !== undefined && at >= 0 && pass(at)) ids.push(node.id);
  });
  return ids;
}

/**
 * What a data export sends with its request: nothing for everything loaded (the server's whole
 * result), else the ids of the visible or the selected nodes of the panel's own result (`own`;
 * without it, all nodes), and nothing either when those are all of them; and, for GraphML, where
 * each node is drawn (px from the drawing's top left, y downwards, rounded to a hundredth). A
 * cluster has one place for many nodes, so its nodes get none.
 */
export function exportScope(
  scope: DataScope,
  model: GraphModel,
  view: GraphView,
  visibility: Visibility,
  selected: ReadonlySet<number>,
  scene: Scene | null,
  own?: ReadonlySet<string>,
): GraphExportScope | undefined {
  const mine = (id: string) => own === undefined || own.has(id);
  const out: GraphExportScope = {};
  if (scope !== "loaded") {
    const ids = idsWhere(
      model,
      view,
      (at) => visibility.nodes[at] === 1 && (scope === "visible" || selected.has(at)),
    ).filter(mine);
    let total = 0;
    for (const node of model.nodes) if (mine(node.id)) total++;
    // All of the result passes: the file is the whole result, with nothing to narrow.
    if (ids.length < total) out.nodes = ids;
  }
  if (scene !== null) {
    const keep = out.nodes === undefined ? null : new Set(out.nodes);
    const positions: Record<string, [number, number]> = {};
    let any = false;
    for (const drawn of scene.nodes) {
      const viewNode = view.nodes[drawn.index];
      const node =
        viewNode === undefined || viewNode.node < 0 ? undefined : model.nodes[viewNode.node];
      if (node === undefined || !mine(node.id) || (keep !== null && !keep.has(node.id))) continue;
      positions[node.id] = [Math.round(drawn.x * 100) / 100, Math.round(drawn.y * 100) / 100];
      any = true;
    }
    if (any && Object.keys(positions).length <= MAX_POSITIONS) out.positions = positions;
  }
  return out.nodes === undefined && out.positions === undefined ? undefined : out;
}
