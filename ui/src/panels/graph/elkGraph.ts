import type { ElkNode } from "elkjs/lib/elk-api";
import type { LayoutGraph } from "./layoutEngine";
import type { ElkDirection, ElkSettings } from "./options";

/**
 * The hierarchy as ELK's JSON graph, and ELK's answer back as the panel's positions. Pure and
 * without elkjs itself, which loads only when a panel picks ELK (elkLayout.ts, elkRunner.ts).
 */

/** Space between a node and its label, and the label's end and the next node; as layoutEngine. */
const LABEL_GAP = 12;

const DIRECTION: Record<ElkDirection, string> = {
  down: "DOWN",
  right: "RIGHT",
  up: "UP",
  left: "LEFT",
};

/** ELK's layout options for the settings; a fixed seed keeps every run of the same data alike. */
export function elkOptions(settings: ElkSettings): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": DIRECTION[settings.direction],
    "elk.spacing.nodeNode": String(settings.nodeSpacing),
    "elk.spacing.componentComponent": String(settings.nodeSpacing),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(settings.layerSpacing),
    "elk.edgeRouting": settings.edgeRouting === "polyline" ? "POLYLINE" : "ORTHOGONAL",
    "elk.randomSeed": "1",
  };
}

/** A node's box: its circle, and the label to its right when it has one. */
function box(graph: LayoutGraph, node: number): { width: number; height: number } {
  const size = graph.sizes[node] ?? 1;
  const label = graph.labels?.[node] ?? 0;
  return { width: 2 * size + (label > 0 ? LABEL_GAP + label : 0), height: 2 * size };
}

/** The graph as ELK reads it: nodes `n<i>` with their box, edges `e<i>` without self-loops. */
export function elkInput(graph: LayoutGraph, settings: ElkSettings): ElkNode {
  const children: ElkNode[] = [];
  for (let i = 0; i < graph.count; i++) {
    children.push({ id: `n${i}`, ...box(graph, i) });
  }
  const edges = [];
  for (let e = 0; e < graph.sources.length; e++) {
    const s = graph.sources[e] as number;
    const t = graph.targets[e] as number;
    if (s !== t) edges.push({ id: `e${e}`, sources: [`n${s}`], targets: [`n${t}`] });
  }
  return { id: "root", layoutOptions: elkOptions(settings), children, edges };
}

/** Whether an edge from `s` to `t` points against the direction (it closed a cycle). */
function against(direction: ElkDirection, positions: Float32Array, s: number, t: number): boolean {
  const sx = positions[2 * s] as number;
  const sy = positions[2 * s + 1] as number;
  const tx = positions[2 * t] as number;
  const ty = positions[2 * t + 1] as number;
  // Graph coordinates grow upwards: "down" means a smaller y.
  switch (direction) {
    case "down":
      return ty > sy;
    case "up":
      return ty < sy;
    case "right":
      return tx < sx;
    case "left":
      return tx > sx;
  }
}

/**
 * The centres of the nodes' circles from ELK's answer, in graph coordinates (y grows upwards, so
 * the first layer of "down" stays on top), and how many edges point against the direction.
 * Throws when the answer lacks a node: the caller falls back to Kalzit's own layout.
 */
export function elkPositions(
  result: ElkNode,
  graph: LayoutGraph,
  direction: ElkDirection,
): { positions: Float32Array; reversed: number } {
  const positions = new Float32Array(graph.count * 2);
  const placed = new Uint8Array(graph.count);
  for (const child of result.children ?? []) {
    const index = Number(child.id.slice(1));
    if (!/^n\d+$/.test(child.id) || index >= graph.count) continue;
    const size = graph.sizes[index] ?? 1;
    const x = child.x;
    const y = child.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x + y)) continue;
    positions[2 * index] = x + size;
    positions[2 * index + 1] = -(y + size);
    placed[index] = 1;
  }
  if (placed.includes(0)) {
    throw new Error("ELK left nodes without a position");
  }
  let reversed = 0;
  for (let e = 0; e < graph.sources.length; e++) {
    const s = graph.sources[e] as number;
    const t = graph.targets[e] as number;
    if (s !== t && against(direction, positions, s, t)) reversed++;
  }
  return { positions, reversed };
}
