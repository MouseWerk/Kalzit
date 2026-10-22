import type Graph from "graphology";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import Sigma from "sigma";
import { extremityArrow, layerPlain, pathLine, pathLoop } from "sigma/rendering";
import type { CameraState } from "sigma/types";
import { applyPositionsTo } from "./applyPositions";
import type { GraphPalette } from "./colors";
import { type Direction, dimsEdges, edgeColor, nodeDisplay, nodeToward } from "./drawing";
import { handOver } from "./handover";
import { refreshVisibility } from "./refresh";
import type { GraphView, Visibility } from "./view";
import "./graph.css";

/**
 * The network drawn with Sigma.js (WebGL 2). Loaded lazily with the first graph panel. Sigma
 * keeps a graphology graph with one node per view node (keyed by index) and draws what the
 * reducers below make of it: colors from the palette, labels by zoom level, and the selection
 * as the design rules want it: everything but the selected node and its neighbours dimmed, the
 * selected node larger and with a bold label. No glow, ring or accent frame.
 */

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
  /**
   * Where the camera is kept between renderers. It belongs to the panel, not to the canvas: a
   * view with other nodes mounts a new canvas, and the zoom and centre must survive that.
   */
  camera: { current: CameraState | null };
  /** A node was clicked (or the background, with null). */
  onPick: (node: number | null) => void;
  /** Shown instead of the renderer's own hint when a gesture needs a modifier key. */
  onGestureHint: (gesture: "wheel" | "touch") => void;
  ref?: Ref<CanvasHandle>;
}

const ZOOM_DURATION = 200;

/** What the renderer's reducers and events read: the newest props of the canvas. */
export interface LiveProps {
  props: SigmaCanvasProps;
  ratioBucket: number;
}

/**
 * The renderer for one graph, with the panel's styles, reducers and events. `allowInvalidContainer`
 * lets it start in a stage that has no size yet (a panel still opening); it draws once it has one.
 */
export function createRenderer(
  graph: Graph,
  host: HTMLElement,
  live: { current: LiveProps },
): Sigma {
  // The reducers run while the renderer is being built (its graph has nodes from the start),
  // before `renderer` exists; until then the camera is at its starting ratio of 1.
  let built: Sigma | null = null;
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
      allowInvalidContainer: true,
      // Wheel and one-finger touch scroll the page; Ctrl or two fingers zoom and pan the graph.
      gestureTarget: "shared",
      hideEdgesOnMove: live.current.props.view.edges.length > 5_000,
      hideLabelsOnMove: true,
      // Which labels show is decided by zoom level (labelAllowed), not by node size.
      labelRenderedSizeThreshold: 0,
      labelDensity: 0.5,
      enableNodeDrag: false,
      // Node sizes are pixels on screen (sigma 4 defaults to graph units, which makes the
      // size depend on the layout's spread).
      itemSizesReference: "screen",
      ...motionSettings(live.current.props.reducedMotion),
    },
    nodeReducer: (key, data) =>
      nodeDisplay(Number(key), data, live.current.props, built?.getCamera().ratio ?? 1),
    edgeReducer: (key, data) => {
      const p = live.current.props;
      const index = Number(key.slice(1));
      const edge = p.view.edges[index];
      if (edge === undefined || p.visibility.edges[index] === 0) {
        return { ...data, visibility: "hidden" };
      }
      return { ...data, color: edgeColor(edge, p) };
    },
  });
  built = renderer;
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
      // Labels belong to nodes; edges need no new pass.
      renderer.scheduleRefresh({
        partialGraph: { nodes: renderer.getGraph().nodes() },
        skipIndexation: true,
      });
    }
  });
  return renderer;
}

export function SigmaCanvas(props: SigmaCanvasProps) {
  const { view, positions, palette, visibility, ranks, selected, neighbours, reducedMotion } =
    props;
  const hostRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const shownVisibility = useRef<Visibility | null>(null);
  // The reducers read the newest props from here; changing them only needs a refresh.
  const live = useRef<LiveProps>({ props, ratioBucket: 0 });
  live.current.props = props;
  // The renderer starts once the stage has a size: a panel that is hidden or still opening
  // has none, and the renderer cannot measure it.
  const [sized, setSized] = useState(false);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const check = (width: number, height: number) => setSized(width > 0 && height > 0);
    const rect = host.getBoundingClientRect();
    check(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) check(box.width, box.height);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // One renderer per view, created with its graph (handover.ts says why); the camera stays
  // where it was, so loading neighbours or opening a group does not jump.
  const camera = props.camera;
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !sized) {
      return;
    }
    const handover = handOver(view, live.current.props.positions, (graph) =>
      createRenderer(graph, host, live),
    );
    const renderer = handover.renderer;
    if (camera.current !== null) {
      renderer.getCamera().setState(camera.current);
    }
    sigmaRef.current = renderer;
    graphRef.current = handover.graph;
    shownVisibility.current = null;
    return () => {
      handover.cancel();
      camera.current = renderer.getCamera().getState();
      renderer.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [view, sized, camera]);

  useEffect(() => {
    sigmaRef.current?.setSettings(motionSettings(reducedMotion));
  }, [reducedMotion]);

  // New positions from the layout move the nodes; the camera keeps its place.
  useEffect(() => {
    const graph = graphRef.current;
    if (graph === null || graph.order !== positions.length / 2) {
      return;
    }
    applyPositionsTo(graph, positions);
  }, [positions]);

  // The time slider: only what changed is drawn again in large graphs (refresh.ts).
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (renderer === null) return;
    const graph = renderer.getGraph();
    // Edges still on their way from the handover are drawn when they arrive.
    const target = {
      refresh: (request: Parameters<typeof renderer.refresh>[0] & object) =>
        renderer.refresh(
          request.partialGraph === undefined
            ? request
            : {
                ...request,
                partialGraph: {
                  nodes: request.partialGraph.nodes ?? [],
                  edges: (request.partialGraph.edges ?? []).filter((e) => graph.hasEdge(e)),
                },
              },
        ),
    };
    refreshVisibility(target, live.current.props.view, shownVisibility.current, visibility);
    shownVisibility.current = visibility;
  }, [visibility]);

  // Theme and label levels change every node's and edge's colors or labels.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each listed prop changes what the reducers draw
  useEffect(() => {
    sigmaRef.current?.refresh({ skipIndexation: true });
  }, [palette, ranks]);

  // Selection: a large graph keeps its edges as they are, so only the nodes are drawn again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each listed prop changes what the reducers draw
  useEffect(() => {
    const renderer = sigmaRef.current;
    const graph = graphRef.current;
    if (renderer === null || graph === null) return;
    if (dimsEdges(live.current.props.view)) {
      renderer.refresh({ skipIndexation: true });
    } else {
      renderer.refresh({ partialGraph: { nodes: graph.nodes() }, skipIndexation: true });
    }
  }, [selected, neighbours]);

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
