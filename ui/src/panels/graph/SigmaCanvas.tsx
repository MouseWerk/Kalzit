import Graph from "graphology";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import Sigma from "sigma";
import { extremityArrow, layerPlain, pathLine, pathLoop } from "sigma/rendering";
import type { NodeDisplayData } from "sigma/types";
import type { GraphPalette } from "./colors";
import { type GraphView, labelAllowed, type Visibility } from "./view";
import "./graph.css";

/**
 * The network drawn with Sigma.js (WebGL 2). Loaded lazily with the first graph panel. Sigma
 * keeps a graphology graph with one node per view node (keyed by index) and draws what the
 * reducers below make of it: colors from the palette, labels by zoom level, and the selection
 * as the design rules want it: everything but the selected node and its neighbours dimmed, the
 * selected node larger and with a bold label. No glow, ring or accent frame.
 */

export type Direction = "left" | "right" | "up" | "down";

export interface CanvasHandle {
  zoom(factor: number): void;
  reset(): void;
  /** The visible node nearest in a direction from `from` (or the most connected one). */
  nodeToward(from: number | null, direction: Direction): number | null;
  /** Moves the camera so the node is in view, unless it already is. */
  reveal(node: number): void;
}

export interface SigmaCanvasProps {
  view: GraphView;
  positions: Float32Array;
  palette: GraphPalette;
  visibility: Visibility;
  ranks: Int32Array;
  selected: number | null;
  /** Neighbours of the selection (view indexes), kept undimmed. */
  neighbours: ReadonlySet<number>;
  reducedMotion: boolean;
  /** A node was clicked (or the background, with null). */
  onPick: (node: number | null) => void;
  /** Shown instead of the renderer's own hint when a gesture needs a modifier key. */
  onGestureHint: (gesture: "wheel" | "touch") => void;
  ref?: Ref<CanvasHandle>;
}

type NodeAttributes = { x: number; y: number; size: number; label: string };

const ZOOM_DURATION = 200;

export function SigmaCanvas(props: SigmaCanvasProps) {
  const { view, positions, palette, visibility, ranks, selected, neighbours, reducedMotion } =
    props;
  const hostRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  // The reducers read the newest props from here; changing them only needs a refresh.
  const live = useRef({ props, ratioBucket: 0 });
  live.current.props = props;

  // One renderer per mount; later props reach it through `live` and the effects below.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const graph = new Graph({ type: "directed", multi: true, allowSelfLoops: true });
    graphRef.current = graph;
    const renderer: Sigma = new Sigma(graph, host, {
      primitives: {
        edges: {
          paths: [pathLine(), pathLoop()],
          extremities: [extremityArrow()],
          layers: [layerPlain()],
          defaultHead: "arrow",
        },
      },
      styles: {
        nodes: {
          x: { attribute: "x" },
          y: { attribute: "y" },
          size: { attribute: "size" },
          label: { attribute: "label" },
          // The renderer's hover backdrop is a white card with a shadow; selection here is
          // shown by dimming instead.
          backdropVisibility: "hidden" as const,
        },
        edges: { size: { attribute: "size" } },
      },
      settings: {
        // Wheel and one-finger touch scroll the page; Ctrl or two fingers zoom and pan the graph.
        gestureTarget: "shared",
        hideEdgesOnMove: graph.size > 5_000,
        hideLabelsOnMove: true,
        labelRenderedSizeThreshold: 4,
        labelDensity: 0.5,
        enableNodeDrag: false,
        ...motionSettings(live.current.props.reducedMotion),
      },
      nodeReducer: (key, data) =>
        nodeDisplay(Number(key), data, live.current.props, renderer.getCamera().ratio),
      edgeReducer: (key, data) => {
        const p = live.current.props;
        const index = Number(key.slice(1));
        const edge = p.view.edges[index];
        if (edge === undefined || p.visibility.edges[index] === 0) {
          return { ...data, visibility: "hidden" };
        }
        const lit = p.selected === null || edge.source === p.selected || edge.target === p.selected;
        return { ...data, color: lit ? p.palette.edge : p.palette.edgeDimmed };
      },
    });
    // The renderer's own gesture hint brings a style element, which the content security policy
    // refuses; the panel shows a translated hint of its own instead.
    renderer._showGestureHint = (gesture) => live.current.props.onGestureHint(gesture);
    renderer.on("clickNode", ({ node }) => live.current.props.onPick(Number(node)));
    renderer.on("clickStage", () => live.current.props.onPick(null));
    // Labels by zoom level: refresh the reducers when the camera crosses into another level.
    renderer.getCamera().on("updated", ({ ratio }) => {
      const bucket = Math.round(Math.log2(Math.max(ratio, 1e-3)) * 2);
      if (bucket !== live.current.ratioBucket) {
        live.current.ratioBucket = bucket;
        renderer.scheduleRefresh({ skipIndexation: true });
      }
    });
    sigmaRef.current = renderer;
    return () => {
      renderer.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    sigmaRef.current?.setSettings(motionSettings(reducedMotion));
  }, [reducedMotion]);

  // A new view replaces the graph's nodes and edges; the positions effect below places them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: positions are applied in their own effect
  useEffect(() => {
    const graph = graphRef.current;
    const renderer = sigmaRef.current;
    if (graph === null || renderer === null) {
      return;
    }
    graph.clear();
    view.nodes.forEach((node, i) => {
      graph.addNode(String(i), {
        x: positions[2 * i] ?? 0,
        y: positions[2 * i + 1] ?? 0,
        size: node.size,
        label: node.caption,
      } satisfies NodeAttributes);
    });
    view.edges.forEach((edge, i) => {
      graph.addEdgeWithKey(`e${i}`, String(edge.source), String(edge.target), {
        size: edge.width,
      });
    });
    renderer.setSetting("hideEdgesOnMove", view.edges.length > 5_000);
  }, [view]);

  // New positions from the layout move the nodes; the camera keeps its place.
  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null || graph.order !== positions.length / 2) {
      return;
    }
    applyPositions(graph, positions);
  }, [positions]);

  // Selection, visibility, theme: only the reducers' output changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each listed prop changes what the reducers draw
  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [selected, neighbours, visibility, palette, ranks]);

  useImperativeHandle(props.ref, () => ({
    zoom(factor) {
      const camera = sigmaRef.current?.getCamera();
      if (camera === undefined) return;
      const duration = live.current.props.reducedMotion ? 0 : ZOOM_DURATION;
      if (factor > 1) void camera.zoomIn({ factor, duration });
      else void camera.zoomOut({ factor: 1 / factor, duration });
    },
    reset() {
      const camera = sigmaRef.current?.getCamera();
      void camera?.reset({ duration: live.current.props.reducedMotion ? 0 : ZOOM_DURATION });
    },
    nodeToward(from, direction) {
      const renderer = sigmaRef.current;
      const p = live.current.props;
      if (renderer === null) return null;
      return nodeToward(
        p.view,
        p.visibility,
        p.ranks,
        from,
        direction,
        (i) => renderer.getNodeDisplayData(String(i)),
        (point) => renderer.framedGraphToViewport(point),
      );
    },
    reveal(node) {
      const renderer = sigmaRef.current;
      const data = renderer?.getNodeDisplayData(String(node));
      if (renderer === null || data === undefined) return;
      const point = renderer.framedGraphToViewport(data);
      const { width, height } = renderer.getDimensions();
      if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
        const camera = renderer.getCamera();
        void camera.animate(
          { x: data.x, y: data.y },
          { duration: live.current.props.reducedMotion ? 0 : ZOOM_DURATION },
        );
      }
    },
  }));

  return <div className="graph__canvas" ref={hostRef} />;
}

/** Camera animations, which reduced motion turns into jumps. */
function motionSettings(reduced: boolean) {
  return {
    zoomDuration: reduced ? 0 : ZOOM_DURATION,
    inertiaDuration: reduced ? 0 : ZOOM_DURATION,
    doubleClickZoomingDuration: reduced ? 0 : ZOOM_DURATION,
  };
}

/** Writes interleaved positions onto the graph's nodes, keyed by index. */
export function applyPositions(graph: Graph, positions: Float32Array): void {
  graph.updateEachNodeAttributes(
    (key, attributes) => {
      const i = Number(key);
      attributes.x = positions[2 * i] ?? 0;
      attributes.y = positions[2 * i + 1] ?? 0;
      return attributes;
    },
    { attributes: ["x", "y"] },
  );
}

/** What the renderer draws for one node, from the panel's state. */
export function nodeDisplay(
  index: number,
  data: NodeDisplayData,
  p: Pick<
    SigmaCanvasProps,
    "view" | "palette" | "visibility" | "ranks" | "selected" | "neighbours"
  >,
  ratio: number,
): Partial<NodeDisplayData> {
  const node = p.view.nodes[index];
  if (node === undefined || p.visibility.nodes[index] === 0) {
    return { ...data, visibility: "hidden" };
  }
  const isSelected = p.selected === index;
  const lit = p.selected === null || isSelected || p.neighbours.has(index);
  const group = node.group;
  const color =
    group < 0
      ? lit
        ? p.palette.neutral
        : p.palette.neutralDimmed
      : ((lit ? p.palette.series : p.palette.dimmed)[group % p.palette.series.length] ?? "#666");
  const allowed = labelAllowed(p.ranks[index] ?? 0, ratio, node.cluster >= 0);
  return {
    ...data,
    color,
    labelColor: p.palette.text,
    size: isSelected ? data.size * 1.4 : data.size,
    labelVisibility: isSelected
      ? "visible"
      : p.selected !== null && !lit
        ? "hidden"
        : allowed
          ? "auto"
          : "hidden",
    zIndex: isSelected ? 1 : 0,
    labelFont: isSelected ? `${p.palette.boldWeight} ${p.palette.font}` : p.palette.font,
  };
}

/**
 * Keyboard navigation in the drawing: the visible node whose screen position lies most nearly in
 * the direction, weighing distance along it and the offset across it. Without a selection the
 * most connected visible node comes first.
 */
export function nodeToward(
  view: GraphView,
  visibility: Visibility,
  ranks: Int32Array,
  from: number | null,
  direction: Direction,
  display: (node: number) => { x: number; y: number } | undefined,
  toViewport: (point: { x: number; y: number }) => { x: number; y: number },
): number | null {
  if (from === null || display(from) === undefined) {
    let best: number | null = null;
    for (let i = 0; i < view.nodes.length; i++) {
      if (visibility.nodes[i] === 1 && (best === null || (ranks[i] ?? 0) < (ranks[best] ?? 0))) {
        best = i;
      }
    }
    return best;
  }
  const origin = toViewport(display(from) as { x: number; y: number });
  let best: number | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < view.nodes.length; i++) {
    if (i === from || visibility.nodes[i] === 0) continue;
    const data = display(i);
    if (data === undefined) continue;
    const point = toViewport(data);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    // Along: distance in the direction (screen y grows downwards); across: sideways offset.
    const along =
      direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
