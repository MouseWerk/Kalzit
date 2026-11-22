import type Graph from "graphology";
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import Sigma from "sigma";
import {
  extremityArrow,
  layerFill,
  pathLine,
  pathLoop,
  sdfCircle,
  sdfDiamond,
  sdfSquare,
  sdfTriangle,
} from "sigma/rendering";
import type { CameraState } from "sigma/types";
import { IMAGE_REDRAW } from "../image";
import { labelWidth } from "../measure";
import { applyPositionsTo } from "./applyPositions";
import { type Area, type AreaMode, nodesInArea, type Point } from "./canvas/selection";
import type { GraphPalette } from "./colors";
import {
  DIM_EDGES_UP_TO,
  type Direction,
  type DrawStyle,
  dimsEdges,
  edgeDisplay,
  nodeDisplay,
  nodeToward,
} from "./drawing";
import { readScene } from "./export/readScene";
import type { Scene } from "./export/scene";
import { handOver } from "./handover";
import { installLabelPickingFix } from "./labelPicking";
import { drawnFrame, installLabelRoom, type LabelFrame } from "./labelRoom";
import { refreshVisibility } from "./refresh";
import { boundingShape, SHAPE_SCALE } from "./shapes";
import { type KeepOut, type Spread, STAGE_PADDING, spreadNodes } from "./spread";
import type { StyledView } from "./style/apply";
import { installBadges } from "./style/badges";
import { iconsNow, loadIcons } from "./style/icons/load";
import { layerRuleBorder, layerRuleIcon, ruleEdgeLayers, sdfHexagon } from "./style/sigmaLayers";
import {
  type GraphView,
  LABEL_BUDGET,
  labelAllowed,
  labelBudgetFor,
  type Visibility,
} from "./view";
import "./graph.css";
import "./canvas/canvas.css";

/**
 * The network drawn with Sigma.js (WebGL 2). Loaded lazily with the first graph panel. Sigma
 * keeps a graphology graph with one node per view node (keyed by index) and draws what the
 * reducers below make of it: colors from the palette, labels by zoom level, and the selection
 * as the design rules want it: everything but the selected node and its neighbours dimmed, the
 * selected node larger and with a bold label on the neutral selection tint. No glow, ring or
 * accent frame.
 */

installLabelPickingFix();

/** What the pointer does on the canvas: pick and drag, or select by rectangle or lasso. */
export type CanvasTool = "pointer" | "rect" | "lasso";

/**
 * A node or an edge of the drawing and where it is on the page: its centre (an edge under the
 * pointer: the pointer) in CSS pixels from the viewport's top left, and how far it reaches from
 * there, so what belongs to it (the info card, a menu) is placed beside it, never over it.
 */
export interface CanvasTarget {
  kind: "node" | "edge";
  /** View index. */
  index: number;
  x: number;
  y: number;
  reach: number;
}

/** A node (view index) and the place it was moved to, in the drawing's own units. */
export interface NodeMove {
  node: number;
  x: number;
  y: number;
}

/** What the minimap draws: the visible nodes and the part the camera shows, in one frame. */
export interface Overview {
  /** Interleaved x, y of the visible nodes (at most OVERVIEW_POINTS of them). */
  points: Float32Array;
  /** The part of the drawing the canvas shows: its top left and bottom right corners. */
  view: { from: Point; to: Point };
}

/** The minimap draws at most this many nodes; beyond it every n-th one stands for the rest. */
export const OVERVIEW_POINTS = 4_000;
/** A press that moves the pointer less than this many px is a click, not a drag. */
export const DRAG_TOLERANCE_PX = 4;
/** How far an arrow key moves the keyboard rectangle's corner, in px; with Shift the larger one. */
export const AREA_STEP_PX = 16;
export const AREA_BIG_STEP_PX = 64;

export type AreaKey = Direction | "enter" | "cancel";

export interface CanvasHandle {
  zoom(factor: number): void;
  reset(): void;
  /** The visible node nearest in a direction from `from` (or the most connected one). */
  nodeToward(from: number | null, direction: Direction): number | null;
  /** Moves the camera so the node is in view, unless it already is. */
  reveal(node: number): void;
  /** What is drawn right now, for a picture of it (export/scene.ts); null before the first draw. */
  scene(): Scene | null;
  /** Moves the camera to the node: the jump to a search hit. */
  focus(node: number): void;
  /** Where the node stands, in the drawing's own units; null while it is not drawn. */
  placeOf(node: number): [number, number] | null;
  /** Where a node or an edge is on the page; null while it is not drawn. */
  targetOf(kind: "node" | "edge", index: number): CanvasTarget | null;
  /** Places the nodes again where the layout and the pins hold them (a refused move goes back). */
  placeAgain(): void;
  /** Moves nodes by so many px on the screen and says where they stand now. */
  nudge(nodes: readonly number[], dx: number, dy: number): NodeMove[];
  /**
   * The rectangle drawn with the keyboard: arrows move its corner, Enter sets the first corner
   * and then selects what lies in it, "cancel" takes it away.
   */
  areaKey(key: AreaKey, big: boolean): void;
  /** What the minimap draws; null before the first frame. */
  overview(): Overview | null;
  /** Moves the camera's centre to a point of the overview. */
  panTo(x: number, y: number): void;
  /** Calls back after every frame drawn, until the returned function is called. */
  subscribe(listener: () => void): () => void;
}

/**
 * Where a drawn node is on the page, in CSS pixels from the viewport's top left: what a pointer
 * clicks to pick it. A hook for the end-to-end tests, on the canvas element (in development, or
 * when the page sets `window.__kalzitTestHooks` first); null for a node that is not drawn.
 */
export type NodePosition = (caption: string) => { x: number; y: number } | null;

export interface CanvasHost extends HTMLDivElement {
  kalzitNodePosition?: NodePosition;
  /** Where a drawn node stands in the drawing's own units (what a pin keeps); null if not drawn. */
  kalzitNodePlace?: (caption: string) => { x: number; y: number } | null;
  /** What the last frame drew, read from the renderer: nodes with their shapes, and its labels. */
  kalzitLabelRoom?: () => LabelFrame | null;
}

export interface SigmaCanvasProps {
  view: GraphView;
  positions: Float32Array;
  palette: GraphPalette;
  visibility: Visibility;
  ranks: Int32Array;
  /** The selected nodes (view indexes). */
  selected: ReadonlySet<number>;
  /** The node the keyboard moves from: the one selected last. */
  primary: number | null;
  /** Neighbours of the selection (view indexes), kept undimmed. */
  neighbours: ReadonlySet<number>;
  /** The selected edges (view indexes), drawn strong and neutral. */
  selectedEdges?: ReadonlySet<number> | undefined;
  /**
   * Pinned nodes (view indexes) and the places they are held at, in the drawing's own units: the
   * layout does not move them, the others make room (spread.ts).
   */
  fixed?: ReadonlyMap<number, readonly [number, number]> | undefined;
  /** Corners of the canvas that tools lie over: no node is placed under them (spread.ts). */
  keepOut?: readonly KeepOut[] | undefined;
  /** What the pointer does; the pointer tool by default. */
  tool?: CanvasTool | undefined;
  /** Whether nodes can be dragged with the pointer tool. */
  draggable?: boolean | undefined;
  drawStyle: DrawStyle;
  /** What the style rules of the panel set, by view index; absent without rules. */
  styled?: StyledView | null | undefined;
  reducedMotion: boolean;
  /**
   * Whether nodes are pushed apart until nodes and labels have room in the panel (spread.ts): the
   * force layout; a hierarchy keeps its layers.
   */
  spread?: boolean;
  /**
   * Whether the layout still moves the nodes: until it settles they are only stretched to the
   * panel, and pushed apart once, on its final positions.
   */
  settling?: boolean;
  /**
   * Where the camera is kept between renderers. It belongs to the panel, not to the canvas: a
   * view with other nodes mounts a new canvas, and the zoom and centre must survive that.
   */
  camera: { current: CameraState | null };
  /**
   * A node was clicked (or the background, with null); `additive` with Shift (or Ctrl or Cmd),
   * which adds the node to the selection or takes it out.
   */
  onPick: (node: number | null, additive: boolean) => void;
  /**
   * Called after each frame with the way from the layout's coordinates to the stage in px: what
   * the layout's guides behind the canvas follow (layouts/GuideLayer.tsx).
   */
  onFrame?: (project: (x: number, y: number) => { x: number; y: number }) => void;
  /** An edge was clicked; `additive` as for nodes. Without it edges take no clicks. */
  onPickEdge?: ((edge: number, additive: boolean) => void) | undefined;
  /** Nodes were dragged and dropped: where each one stands now. */
  onMove?: ((moves: readonly NodeMove[]) => void) | undefined;
  /** The pointer came to rest over a node or an edge, or left it (null). */
  onHover?: ((target: CanvasTarget | null) => void) | undefined;
  /**
   * A right click on a node, an edge or the empty canvas (null), at this place on the page.
   * Shift+right click is left to the browser's own menu.
   */
  onMenu?: ((target: CanvasTarget | null, at: { x: number; y: number }) => void) | undefined;
  /** A rectangle or a lasso was drawn around these nodes (view indexes). */
  onArea?: ((nodes: readonly number[], mode: AreaMode) => void) | undefined;
  /** The renderer is there to draw and to be followed (true), or gone (false). */
  onReady?: ((ready: boolean) => void) | undefined;
  /** Shown instead of the renderer's own hint when a gesture needs a modifier key. */
  onGestureHint: (gesture: "wheel" | "touch") => void;
  ref?: Ref<CanvasHandle>;
}

const ZOOM_DURATION = 200;

/** What the renderer's reducers and events read: the newest props of the canvas. */
export interface LiveProps {
  props: SigmaCanvasProps;
  ratioBucket: number;
  /** The label budget of the panel's size (labelBudgetFor). */
  budget?: number;
  /** Where the nodes are drawn, with the box the renderer frames (spread.ts). */
  placed?: Spread;
  /** While nodes are dragged: no info card, and the click that ends the drag picks nothing. */
  dragging?: boolean;
  /** Shows the dashed outline where a dragged node stood, or takes it away (null). */
  onGhost?: (ghost: Ghost | null) => void;
}

/** Where a dragged node stood when the drag began, on the canvas in px. */
export interface Ghost {
  x: number;
  y: number;
  r: number;
}

/** The renderer's label size in px (sigma's default). */
const LABEL_SIZE = 14;
/** How long a resize must rest before the nodes are placed again for the new size, in ms. */
const SETTLE_MS = 120;

const measured = new Map<string, number>();

/** A label's width in px in the panel's font (measured once per text, once the fonts loaded). */
function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const known = measured.get(key);
  if (known !== undefined) return known;
  const width = labelWidth(text, `${LABEL_SIZE}px ${font}`);
  // Before the web font has loaded the text is measured in a fallback font: not kept.
  if (typeof document !== "undefined" && document.fonts?.status === "loading") return width;
  if (measured.size > 5_000) measured.clear();
  measured.set(key, width);
  return width;
}

/**
 * Whether a node's label shows at the fitted zoom, whatever is selected or hidden: the labels the
 * placement makes room for. Selection and the legend do not move nodes.
 */
function labelAtFit(i: number, p: SigmaCanvasProps, budget: number): boolean {
  const node = p.view.nodes[i];
  if (node === undefined || node.caption === "") return false;
  const mode = p.drawStyle.labels;
  if (mode === "always") return true;
  if (mode === "selection") return false;
  const rank = p.ranks[i] ?? 0;
  return rank < p.drawStyle.labelTop || labelAllowed(rank, 1, node.cluster >= 0, budget);
}

/** Where the nodes go in a panel of this size, and the box the renderer frames (spread.ts). */
export function placement(
  p: SigmaCanvasProps,
  width: number,
  height: number,
  budget: number,
): Spread {
  const nodes = p.view.nodes;
  // Sizes, shapes and names a style rule set count for the room a node needs.
  const looks = p.styled?.nodes;
  const radii = Float32Array.from(
    nodes,
    (node, i) => (looks?.[i]?.size ?? node.size) * SHAPE_SCALE[looks?.[i]?.shape ?? node.shape],
  );
  const labels = Float32Array.from(nodes, (node, i) =>
    labelAtFit(i, p, budget) ? textWidth(looks?.[i]?.caption ?? node.caption, p.palette.font) : 0,
  );
  return spreadNodes({
    positions: p.positions,
    radii,
    labels,
    ranks: p.ranks,
    labelHeight: LABEL_SIZE,
    width,
    height,
    move: p.spread === false ? "keep" : p.settling === true ? "stretch" : "spread",
    ...(p.fixed === undefined || p.fixed.size === 0 ? {} : { fixed: p.fixed }),
    ...(p.keepOut === undefined ? {} : { keepOut: p.keepOut }),
  });
}

/**
 * Places the nodes for the renderer's size: its framed box first, then the positions. With
 * `keepBox` the framed box stays as it is: a node dropped outside it must not rescale the
 * drawing under the pointer; the next layout, resize or "Show all" frames it again.
 */
function place(renderer: Sigma, graph: Graph, live: { current: LiveProps }, keepBox = false): void {
  const p = live.current.props;
  if (graph.order !== p.positions.length / 2) return;
  const { width, height } = renderer.getDimensions();
  const placed = placement(p, width, height, live.current.budget ?? LABEL_BUDGET);
  live.current.placed = placed;
  if (!keepBox) renderer.setCustomBBox(placed.bbox);
  applyPositionsTo(graph, placed.positions);
}

/** Where a node or an edge is on the page (CanvasTarget); an edge at `pointer` when given. */
function targetOf(
  renderer: Sigma,
  host: HTMLElement,
  p: SigmaCanvasProps,
  kind: "node" | "edge",
  index: number,
  pointer?: { x: number; y: number },
): CanvasTarget | null {
  const box = host.getBoundingClientRect();
  if (kind === "node") {
    const data = renderer.getNodeDisplayData(String(index));
    if (data === undefined) return null;
    const at = renderer.framedGraphToViewport(data);
    return {
      kind,
      index,
      x: box.left + at.x,
      y: box.top + at.y,
      reach: renderer.scaleSize(data.size),
    };
  }
  if (pointer !== undefined) {
    return { kind, index, x: box.left + pointer.x, y: box.top + pointer.y, reach: EDGE_REACH_PX };
  }
  const edge = p.view.edges[index];
  const from = edge === undefined ? undefined : renderer.getNodeDisplayData(String(edge.source));
  const to = edge === undefined ? undefined : renderer.getNodeDisplayData(String(edge.target));
  if (from === undefined || to === undefined) return null;
  const a = renderer.framedGraphToViewport(from);
  const b = renderer.framedGraphToViewport(to);
  return {
    kind,
    index,
    x: box.left + (a.x + b.x) / 2,
    y: box.top + (a.y + b.y) / 2,
    reach: EDGE_REACH_PX,
  };
}

/** How far an edge reaches from the point it was touched at, in px: half its picking strip. */
const EDGE_REACH_PX = 4;

/** The nodes that move with a dragged one: the selection it belongs to, or it alone. */
function draggedWith(node: string, p: SigmaCanvasProps): string[] {
  const index = Number(node);
  if (!p.selected.has(index) || p.selected.size < 2) return [node];
  return [...p.selected]
    .filter((i) => p.visibility.nodes[i] === 1 && (p.view.nodes[i]?.node ?? -1) >= 0)
    .map(String);
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
  // The first drawing already keeps to the panel's label budget, not only the one after the
  // first settle.
  live.current.budget = labelBudgetFor(host.offsetWidth, host.offsetHeight);
  const renderer: Sigma = new Sigma(graph, host, {
    primitives: {
      // A shape per label, as a second cue next to color (shapes.ts); style rules may set a
      // triangle or a hexagon too, a frame and an icon (style/sigmaLayers.ts).
      nodes: {
        shapes: [sdfCircle(), sdfSquare(), sdfDiamond(), sdfTriangle(), sdfHexagon()],
        layers: [layerFill(), layerRuleBorder(), layerRuleIcon()],
      },
      edges: {
        paths: [pathLine(), pathLoop()],
        extremities: [extremityArrow()],
        // The plain color, and dashes for the edges a style rule draws dashed or dotted.
        layers: ruleEdgeLayers(),
        // Arrows per edge (edgeDisplay), so the panel can draw them always, at the selection or
        // never.
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
      // Which labels show is decided by zoom level (labelAllowed), not by node size, and the
      // ones that would cover something are left out per frame (labelRoom.ts): the renderer's
      // own label grid, which keeps one label in every other cell of 100 px, lets them all pass.
      labelRenderedSizeThreshold: 0,
      labelDensity: 100,
      renderEdgeLabels: edgeLabelsOn(live.current.props),
      // Dragging a node pins it where it is dropped (Graph 0.8.1 board, frame 1); several
      // selected nodes move together. Only with the pointer tool.
      enableNodeDrag:
        live.current.props.draggable === true &&
        (live.current.props.tool ?? "pointer") === "pointer",
      getDraggedNodes: (node) => draggedWith(node, live.current.props),
      // Edges take clicks and hovering in a strip of 8 px around the line; a node under the
      // pointer wins. Not in graphs so large that their edges are not even dimmed.
      enableEdgeEvents:
        live.current.props.onPickEdge !== undefined &&
        live.current.props.view.edges.length <= DIM_EDGES_UP_TO,
      edgePickingPadding: EDGE_REACH_PX,
      // Node sizes are pixels on screen (sigma 4 defaults to graph units, which makes the
      // size depend on the layout's spread).
      itemSizesReference: "screen",
      // The framed box already reaches around nodes and labels (spread.ts).
      stagePadding: STAGE_PADDING,
      ...motionSettings(live.current.props.reducedMotion),
    },
    nodeReducer: (key, data) =>
      nodeDisplay(
        Number(key),
        data,
        live.current.props,
        built?.getCamera().ratio ?? 1,
        live.current.budget,
        live.current.placed?.nodeScale,
      ),
    edgeReducer: (key, data) => edgeDisplay(Number(key.slice(1)), data, live.current.props),
  });
  built = renderer;
  // The box placed for this graph before the renderer existed (the first drawing fits it).
  const placed = live.current.placed;
  if (placed !== undefined && placed.positions.length === graph.order * 2) {
    renderer.setCustomBBox(placed.bbox);
    renderer.refresh();
  }
  // No label covers a node or another label, checked on every frame (labelRoom.ts).
  installLabelRoom(renderer, {
    rank: (i) => live.current.props.ranks[i] ?? 0,
    shape: (i) => {
      const p = live.current.props;
      return boundingShape(p.styled?.nodes[i]?.shape ?? p.view.nodes[i]?.shape ?? "circle");
    },
  });
  // Badges of style rules, on a canvas of their own above the drawing (style/badges.ts).
  const removeBadges = installBadges(renderer, host, () => {
    const p = live.current.props;
    return {
      styled: p.styled,
      visible: (node) => p.visibility.nodes[node] === 1,
      dimmed: (node) => p.selected.size > 0 && !p.selected.has(node) && !p.neighbours.has(node),
      palette: p.palette,
    };
  });
  // The renderer's own gesture hint brings a style element, which the content security policy
  // refuses; the panel shows a translated hint of its own instead.
  renderer._showGestureHint = (gesture) => live.current.props.onGestureHint(gesture);
  const additive = (event: { original: MouseEvent | TouchEvent }) =>
    event.original.shiftKey || event.original.ctrlKey || event.original.metaKey;
  // The click that ends a drag picks nothing.
  let dropped = false;
  renderer.on("clickNode", ({ node, event }) => {
    if (!dropped) live.current.props.onPick(Number(node), additive(event));
  });
  renderer.on("clickStage", ({ event }) => {
    if (!dropped) live.current.props.onPick(null, additive(event));
  });
  renderer.on("clickEdge", ({ edge, event }) => {
    if (!dropped) live.current.props.onPickEdge?.(Number(edge.slice(1)), additive(event));
  });
  // Dragging: the nodes follow the pointer (the renderer moves them); on release the panel pins
  // them where they stand. A press that barely moves stays a click, and a group is not dragged.
  let dragFrom: { x: number; y: number; places: Map<string, { x: number; y: number }> } | null =
    null;
  renderer.on("nodeDragStart", (payload) => {
    const p = live.current.props;
    if ((p.view.nodes[Number(payload.node)]?.node ?? -1) < 0) {
      payload.preventSigmaDefault();
      return;
    }
    const drawn = renderer.getGraph();
    dragFrom = {
      x: payload.event.x,
      y: payload.event.y,
      places: new Map(
        payload.allDraggedNodes.map((key) => [
          key,
          {
            x: drawn.getNodeAttribute(key, "x") as number,
            y: drawn.getNodeAttribute(key, "y") as number,
          },
        ]),
      ),
    };
    live.current.dragging = true;
    p.onHover?.(null);
    const data = renderer.getNodeDisplayData(payload.node);
    if (data !== undefined) {
      const at = renderer.framedGraphToViewport(data);
      live.current.onGhost?.({ x: at.x, y: at.y, r: renderer.scaleSize(data.size) });
    }
  });
  renderer.on("nodeDragEnd", (payload) => {
    const from = dragFrom;
    dragFrom = null;
    live.current.dragging = false;
    live.current.onGhost?.(null);
    if (from === null) return;
    const drawn = renderer.getGraph();
    const far = Math.hypot(payload.event.x - from.x, payload.event.y - from.y);
    if (far < DRAG_TOLERANCE_PX) {
      for (const [key, at] of from.places) {
        if (drawn.hasNode(key)) drawn.mergeNodeAttributes(key, at);
      }
      return;
    }
    dropped = true;
    setTimeout(() => {
      dropped = false;
    }, 0);
    const moves: NodeMove[] = [];
    for (const key of from.places.keys()) {
      if (!drawn.hasNode(key)) continue;
      moves.push({
        node: Number(key),
        x: drawn.getNodeAttribute(key, "x") as number,
        y: drawn.getNodeAttribute(key, "y") as number,
      });
    }
    live.current.props.onMove?.(moves);
  });
  // Hovering: the panel shows the info card once the pointer rests (frame 1); not while dragging.
  const hover = (kind: "node" | "edge", index: number, pointer?: { x: number; y: number }) => {
    if (live.current.dragging === true) return;
    const p = live.current.props;
    p.onHover?.(targetOf(renderer, host, p, kind, index, pointer));
  };
  renderer.on("enterNode", ({ node }) => hover("node", Number(node)));
  renderer.on("leaveNode", () => live.current.props.onHover?.(null));
  renderer.on("enterEdge", ({ edge, event }) => hover("edge", Number(edge.slice(1)), event));
  renderer.on("leaveEdge", () => live.current.props.onHover?.(null));
  // Right click: the panel's own menu for what lies under the pointer; with Shift the browser's.
  const menu =
    (kind: "node" | "edge" | null) =>
    (payload: {
      node?: string;
      edge?: string;
      event: { x: number; y: number; original: Event };
    }) => {
      const p = live.current.props;
      const original = payload.event.original;
      if (p.onMenu === undefined || !(original instanceof MouseEvent) || original.shiftKey) return;
      original.preventDefault();
      const index =
        kind === "node"
          ? Number(payload.node)
          : kind === "edge"
            ? Number((payload.edge ?? "").slice(1))
            : -1;
      const target = kind === null ? null : targetOf(renderer, host, p, kind, index, payload.event);
      p.onMenu(target, { x: original.clientX, y: original.clientY });
    };
  renderer.on("rightClickNode", menu("node"));
  renderer.on("rightClickEdge", menu("edge"));
  renderer.on("rightClickStage", menu(null));
  // After a resize the panel has another label budget and another size to place nodes in; both
  // wait until the resize rests.
  let settle: ReturnType<typeof setTimeout> | undefined;
  let killed = false;
  const check = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const { width, height } = renderer.getDimensions();
      const budget = labelBudgetFor(width, height);
      if (budget !== live.current.budget) {
        live.current.budget = budget;
        // Every node's label may come or go with another budget.
        renderer.refresh({ partialGraph: { nodes: renderer.getGraph().nodes() } });
      }
      place(renderer, renderer.getGraph(), live);
    }, SETTLE_MS);
  };
  renderer.on("resize", check);
  const project = (x: number, y: number) => renderer.graphToViewport({ x, y });
  renderer.on("afterRender", () => live.current.props.onFrame?.(project));
  renderer.on("kill", () => {
    killed = true;
    clearTimeout(settle);
    removeBadges();
  });
  // Labels measured in a fallback font while the web font loaded are measured again.
  if (typeof document !== "undefined" && document.fonts?.status === "loading") {
    void document.fonts.ready.then(() => {
      if (!killed) check();
    });
  }
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
  const {
    view,
    positions,
    palette,
    visibility,
    ranks,
    selected,
    neighbours,
    selectedEdges,
    fixed,
    drawStyle,
    styled,
    reducedMotion,
  } = props;
  const tool = props.tool ?? "pointer";
  const draggable = props.draggable === true;
  const hostRef = useRef<CanvasHost>(null);
  // Where a dragged node stood, the area being drawn with the pointer, and the rectangle drawn
  // with the keyboard (its moving corner, and the first corner once Enter set it).
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [keyArea, setKeyArea] = useState<{ cursor: Point; anchor: Point | null } | null>(null);
  const listeners = useRef(new Set<() => void>());
  const shownFixed = useRef(fixed);
  const shownEdges = useRef(selectedEdges);
  const sigmaRef = useRef<Sigma | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const shownVisibility = useRef<Visibility | null>(null);
  // The reducers read the newest props from here; changing them only needs a refresh.
  const live = useRef<LiveProps>({ props, ratioBucket: 0 });
  live.current.props = props;
  live.current.onGhost = setGhost;
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
    // The nodes are placed for the stage's size before the renderer draws them first.
    const placed = placement(
      live.current.props,
      host.offsetWidth,
      host.offsetHeight,
      labelBudgetFor(host.offsetWidth, host.offsetHeight),
    );
    live.current.placed = placed;
    const handover = handOver(view, placed.positions, (graph) => createRenderer(graph, host, live));
    const renderer = handover.renderer;
    if (camera.current !== null) {
      renderer.getCamera().setState(camera.current);
    }
    sigmaRef.current = renderer;
    graphRef.current = handover.graph;
    shownVisibility.current = null;
    shownFixed.current = live.current.props.fixed;
    shownEdges.current = live.current.props.selectedEdges;
    // The minimap follows every frame.
    const frame = () => {
      for (const listener of listeners.current) listener();
    };
    renderer.on("afterRender", frame);
    // A panel image reads the canvases right after this draw (panels/image.ts).
    const redraw = () => renderer.refresh();
    host.addEventListener(IMAGE_REDRAW, redraw);
    live.current.props.onReady?.(true);
    return () => {
      live.current.props.onReady?.(false);
      host.removeEventListener(IMAGE_REDRAW, redraw);
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

  // Nodes are dragged with the pointer tool only; a rectangle or a lasso selects instead.
  useEffect(() => {
    sigmaRef.current?.setSetting("enableNodeDrag", draggable && tool === "pointer");
    if (tool !== "rect") setKeyArea(null);
    if (tool === "pointer") setArea(null);
  }, [draggable, tool]);

  // Pinned, released or moved back: the nodes are placed again, in the box they are framed in.
  useEffect(() => {
    const renderer = sigmaRef.current;
    const graph = graphRef.current;
    if (renderer === null || graph === null || shownFixed.current === fixed) return;
    shownFixed.current = fixed;
    place(renderer, graph, live, true);
  }, [fixed]);

  // A selected edge changes how edges are drawn, also in graphs that draw only nodes again.
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (renderer === null || shownEdges.current === selectedEdges) return;
    shownEdges.current = selectedEdges;
    renderer.refresh({ skipIndexation: true });
  }, [selectedEdges]);

  // The style changes what every node and edge draws; edge labels need the renderer's setting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reducers read the props through `live`; these trigger the redraw
  useEffect(() => {
    const renderer = sigmaRef.current;
    if (renderer === null) return;
    renderer.setSetting("renderEdgeLabels", edgeLabelsOn(live.current.props));
    renderer.refresh({ skipIndexation: true });
    // Which labels show at the fitted zoom decides how much room the nodes need.
    const graph = graphRef.current;
    if (graph !== null) place(renderer, graph, live);
  }, [drawStyle, styled]);

  // The icons of style rules load with the first rule that names one; the nodes are drawn again
  // once they are there.
  useEffect(() => {
    if (styled === null || styled === undefined || styled.icons.length === 0) return;
    if (iconsNow() !== null) return;
    let current = true;
    loadIcons().then(
      () => {
        if (current) sigmaRef.current?.refresh({ skipIndexation: true });
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [styled]);

  // The test hooks: where a node with this caption is drawn on the page, and what the last frame
  // drew. Only in development and where the end-to-end tests ask for them, never in a viewer's
  // browser.
  useEffect(() => {
    const host = hostRef.current;
    const asked = (window as { __kalzitTestHooks?: boolean }).__kalzitTestHooks === true;
    if (host === null || !(import.meta.env.DEV || asked)) return;
    host.kalzitNodePosition = (caption) => {
      const renderer = sigmaRef.current;
      const p = live.current.props;
      const index = p.view.nodes.findIndex(
        (node, i) => node.caption === caption && p.visibility.nodes[i] === 1,
      );
      const data = index < 0 ? undefined : renderer?.getNodeDisplayData(String(index));
      if (renderer === null || data === undefined) return null;
      const point = renderer.framedGraphToViewport(data);
      const box = host.getBoundingClientRect();
      return { x: box.left + point.x, y: box.top + point.y };
    };
    host.kalzitLabelRoom = () => {
      const renderer = sigmaRef.current;
      return renderer === null ? null : drawnFrame(renderer);
    };
    host.kalzitNodePlace = (caption) => {
      const graph = graphRef.current;
      const p = live.current.props;
      const index = p.view.nodes.findIndex(
        (node, i) => node.caption === caption && p.visibility.nodes[i] === 1,
      );
      if (graph === null || index < 0 || !graph.hasNode(String(index))) return null;
      return {
        x: graph.getNodeAttribute(String(index), "x") as number,
        y: graph.getNodeAttribute(String(index), "y") as number,
      };
    };
    return () => {
      delete host.kalzitNodePosition;
      delete host.kalzitLabelRoom;
      delete host.kalzitNodePlace;
    };
  }, []);

  // New positions from the layout move the nodes, placed for the panel; the camera keeps its
  // place.
  useEffect(() => {
    const renderer = sigmaRef.current;
    const graph = graphRef.current;
    if (renderer === null || graph === null || graph.order !== positions.length / 2) {
      return;
    }
    place(renderer, graph, live);
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

  /** Each node's centre on the canvas in px (NaN for one that is not drawn), for the areas. */
  function centres(): Float32Array {
    const renderer = sigmaRef.current;
    const p = live.current.props;
    const out = new Float32Array(p.view.nodes.length * 2).fill(Number.NaN);
    if (renderer === null) return out;
    for (let i = 0; i < p.view.nodes.length; i++) {
      if (p.visibility.nodes[i] !== 1) continue;
      const data = renderer.getNodeDisplayData(String(i));
      if (data === undefined) continue;
      const at = renderer.framedGraphToViewport(data);
      out[2 * i] = at.x;
      out[2 * i + 1] = at.y;
    }
    return out;
  }

  function finishArea(drawn: Area, mode: AreaMode) {
    live.current.props.onArea?.(nodesInArea(centres(), drawn), mode);
  }

  function pointOf(event: { clientX: number; clientY: number }): Point {
    const box = hostRef.current?.getBoundingClientRect();
    return [event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0)];
  }

  useImperativeHandle(props.ref, () => ({
    focus(node) {
      const renderer = sigmaRef.current;
      const data = renderer?.getNodeDisplayData(String(node));
      if (renderer === null || data === undefined) return;
      void renderer
        .getCamera()
        .animate(
          { x: data.x, y: data.y },
          { duration: live.current.props.reducedMotion ? 0 : ZOOM_DURATION },
        );
    },
    placeOf(node) {
      const graph = graphRef.current;
      const key = String(node);
      if (graph === null || !graph.hasNode(key)) return null;
      const x = graph.getNodeAttribute(key, "x") as number;
      const y = graph.getNodeAttribute(key, "y") as number;
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    },
    targetOf(kind, index) {
      const renderer = sigmaRef.current;
      const host = hostRef.current;
      if (renderer === null || host === null) return null;
      return targetOf(renderer, host, live.current.props, kind, index);
    },
    placeAgain() {
      const renderer = sigmaRef.current;
      const graph = graphRef.current;
      if (renderer !== null && graph !== null) place(renderer, graph, live, true);
    },
    nudge(nodes, dx, dy) {
      const renderer = sigmaRef.current;
      const graph = graphRef.current;
      if (renderer === null || graph === null) return [];
      const from = renderer.viewportToGraph({ x: 0, y: 0 });
      const to = renderer.viewportToGraph({ x: dx, y: dy });
      const moves: NodeMove[] = [];
      for (const node of nodes) {
        const key = String(node);
        if (!graph.hasNode(key)) continue;
        const x = (graph.getNodeAttribute(key, "x") as number) + to.x - from.x;
        const y = (graph.getNodeAttribute(key, "y") as number) + to.y - from.y;
        graph.mergeNodeAttributes(key, { x, y });
        moves.push({ node, x, y });
      }
      return moves;
    },
    areaKey(key, big) {
      const renderer = sigmaRef.current;
      if (renderer === null) return;
      if (key === "cancel") {
        setKeyArea(null);
        return;
      }
      const { width, height } = renderer.getDimensions();
      const p = live.current.props;
      const start = (): Point => {
        const data =
          p.primary === null ? undefined : renderer.getNodeDisplayData(String(p.primary));
        if (data === undefined) return [width / 2, height / 2];
        const at = renderer.framedGraphToViewport(data);
        return [at.x, at.y];
      };
      const now = keyArea ?? { cursor: start(), anchor: null };
      if (key === "enter") {
        if (now.anchor === null) {
          setKeyArea({ cursor: now.cursor, anchor: now.cursor });
        } else {
          setKeyArea(null);
          finishArea({ kind: "rect", from: now.anchor, to: now.cursor }, "replace");
        }
        return;
      }
      const step = big ? AREA_BIG_STEP_PX : AREA_STEP_PX;
      const dx = key === "left" ? -step : key === "right" ? step : 0;
      const dy = key === "up" ? -step : key === "down" ? step : 0;
      setKeyArea({
        anchor: now.anchor,
        cursor: [
          Math.min(width, Math.max(0, now.cursor[0] + dx)),
          Math.min(height, Math.max(0, now.cursor[1] + dy)),
        ],
      });
    },
    overview() {
      const renderer = sigmaRef.current;
      if (renderer === null) return null;
      const p = live.current.props;
      const count = p.view.nodes.length;
      const stride = Math.max(1, Math.ceil(count / OVERVIEW_POINTS));
      const points: number[] = [];
      for (let i = 0; i < count; i += stride) {
        if (p.visibility.nodes[i] !== 1) continue;
        const data = renderer.getNodeDisplayData(String(i));
        if (data !== undefined) points.push(data.x, data.y);
      }
      const { width, height } = renderer.getDimensions();
      const from = renderer.viewportToFramedGraph({ x: 0, y: 0 });
      const to = renderer.viewportToFramedGraph({ x: width, y: height });
      return {
        points: Float32Array.from(points),
        view: { from: [from.x, from.y], to: [to.x, to.y] },
      };
    },
    panTo(x, y) {
      const camera = sigmaRef.current?.getCamera();
      void camera?.animate(
        { x, y },
        { duration: live.current.props.reducedMotion ? 0 : ZOOM_DURATION },
      );
    },
    subscribe(listener) {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
    zoom(factor) {
      const camera = sigmaRef.current?.getCamera();
      if (camera === undefined) return;
      const duration = live.current.props.reducedMotion ? 0 : ZOOM_DURATION;
      if (factor > 1) void camera.zoomIn({ factor, duration });
      else void camera.zoomOut({ factor: 1 / factor, duration });
    },
    reset() {
      const renderer = sigmaRef.current;
      const graph = graphRef.current;
      // "Show all" frames the nodes as they stand now, dropped ones included.
      if (renderer !== null && graph !== null) place(renderer, graph, live);
      const camera = renderer?.getCamera();
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
        from ?? p.primary,
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
    scene() {
      const renderer = sigmaRef.current;
      return renderer === null ? null : readScene(renderer, live.current.props);
    },
  }));

  const corner = keyArea?.cursor ?? null;
  const drawnRect =
    area?.kind === "rect"
      ? area
      : keyArea !== null && keyArea.anchor !== null
        ? { from: keyArea.anchor, to: keyArea.cursor }
        : null;
  // `data-image-redraw` (IMAGE_REDRAW_ATTRIBUTE): sent IMAGE_REDRAW before a panel image is made.
  return (
    <>
      <div className="graph__canvas" ref={hostRef} data-image-redraw="" />
      {ghost === null ? null : (
        // Where the dragged node stood, until it is dropped: a dashed neutral outline.
        <svg className="graph__marks" aria-hidden="true">
          <circle className="graph__ghost" cx={ghost.x} cy={ghost.y} r={Math.max(3, ghost.r)} />
        </svg>
      )}
      {tool === "pointer" ? null : (
        // The rectangle and the lasso: drawn over the canvas, which gets no pointer meanwhile.
        <svg
          className="graph__marquee"
          aria-hidden="true"
          data-tool={tool}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            const at = pointOf(event);
            setKeyArea(null);
            setArea(
              tool === "rect"
                ? { kind: "rect", from: at, to: at }
                : { kind: "lasso", points: [at] },
            );
          }}
          onPointerMove={(event) => {
            if (area === null) return;
            const at = pointOf(event);
            if (area.kind === "rect") {
              setArea({ ...area, to: at });
              return;
            }
            const last = area.points.at(-1) as Point;
            // A point every few px is enough for a lasso.
            if (Math.hypot(at[0] - last[0], at[1] - last[1]) >= 3) {
              setArea({ kind: "lasso", points: [...area.points, at] });
            }
          }}
          onPointerUp={(event) => {
            if (area === null) return;
            setArea(null);
            finishArea(area, event.shiftKey ? "add" : event.altKey ? "remove" : "replace");
          }}
          onPointerCancel={() => setArea(null)}
        >
          {drawnRect === null ? null : (
            <rect
              className="graph__area"
              x={Math.min(drawnRect.from[0], drawnRect.to[0])}
              y={Math.min(drawnRect.from[1], drawnRect.to[1])}
              width={Math.abs(drawnRect.to[0] - drawnRect.from[0])}
              height={Math.abs(drawnRect.to[1] - drawnRect.from[1])}
            />
          )}
          {area?.kind === "lasso" && area.points.length > 1 ? (
            <polygon
              className="graph__area"
              points={area.points.map((point) => `${point[0]},${point[1]}`).join(" ")}
            />
          ) : null}
          {corner === null ? null : (
            <path
              className="graph__area-corner"
              d={`M${corner[0] - 6} ${corner[1]}h12M${corner[0]} ${corner[1] - 6}v12`}
            />
          )}
        </svg>
      )}
    </>
  );
}

/** Whether edges carry texts: the type labels of the panel, or a text a style rule set. */
function edgeLabelsOn(p: SigmaCanvasProps): boolean {
  return p.drawStyle.edgeLabels !== "never" || p.styled?.edgeLabels === true;
}

/** Camera animations, which reduced motion turns into jumps. */
function motionSettings(reduced: boolean) {
  return {
    zoomDuration: reduced ? 0 : ZOOM_DURATION,
    inertiaDuration: reduced ? 0 : ZOOM_DURATION,
    doubleClickZoomingDuration: reduced ? 0 : ZOOM_DURATION,
  };
}
