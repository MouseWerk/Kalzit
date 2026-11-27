import type Sigma from "sigma";
import type { GraphPalette } from "../colors";
import { drawnFrame } from "../labelRoom";
import type { NodeShape } from "../shapes";
import type { GraphView } from "../view";
import type { Scene, SceneEdge, SceneNode } from "./scene";

/**
 * Reads what the renderer draws right now into a scene (scene.ts): the only part of the picture
 * export that knows Sigma. Places, sizes, colors and labels are the renderer's own display data,
 * after the panel's reducers, so the picture has what the screen has: the camera, the selection's
 * dimming, hidden labels and the time slider.
 */

export interface SceneSource {
  view: GraphView;
  palette: GraphPalette;
  ranks: Int32Array;
  selected: ReadonlySet<number>;
}

/** The size of node labels in px (the renderer's). */
export const SCENE_LABEL_SIZE = 14;

function shapeOf(value: unknown): NodeShape {
  return value === "square" || value === "diamond" ? value : "circle";
}

export function readScene(renderer: Sigma, source: SceneSource): Scene {
  const { width, height } = renderer.getDimensions();
  // The labels the last frame drew, after the check for room (labelRoom.ts); none while the
  // camera moves, or where the renderer no longer has what the check reads.
  const shown = new Set((drawnFrame(renderer)?.labels ?? []).map((label) => label.index));
  const nodes: SceneNode[] = [];
  const place = new Map<number, number>();
  for (const key of renderer.getGraph().nodes()) {
    const data = renderer.getNodeDisplayData(key);
    if (data === undefined || data.visibility === "hidden") continue;
    const index = Number(key);
    const point = renderer.framedGraphToViewport(data);
    const label = typeof data.label === "string" && data.label !== "" ? data.label : null;
    place.set(index, nodes.length);
    nodes.push({
      index,
      x: point.x,
      y: point.y,
      radius: renderer.scaleSize(data.size),
      shape: shapeOf(data.shape),
      color: data.color,
      label,
      labelShown: label !== null && shown.has(index),
      labelForced: data.labelVisibility === "visible",
      selected: source.selected.has(index),
      rank: source.ranks[index] ?? 0,
    });
  }
  const edges: SceneEdge[] = [];
  const graph = renderer.getGraph();
  source.view.edges.forEach((edge, i) => {
    const key = `e${i}`;
    // Edges of a large graph arrive after its nodes (handover.ts); one not there yet is not drawn.
    if (!graph.hasEdge(key)) return;
    const data = renderer.getEdgeDisplayData(key);
    const from = place.get(edge.source);
    const to = place.get(edge.target);
    if (
      data === undefined ||
      data.visibility === "hidden" ||
      from === undefined ||
      to === undefined
    ) {
      return;
    }
    edges.push({
      source: from,
      target: to,
      color: data.color,
      width: Math.max(0.5, renderer.scaleSize(data.size)),
      arrow: data.head === "arrow",
      label: typeof data.label === "string" && data.label !== "" ? data.label : null,
    });
  });
  return {
    width,
    height,
    nodes,
    edges,
    colors: {
      text: source.palette.text,
      background: source.palette.background,
      selection: source.palette.selection,
    },
    font: source.palette.font,
    boldWeight: source.palette.boldWeight,
    labelSize: SCENE_LABEL_SIZE,
  };
}
