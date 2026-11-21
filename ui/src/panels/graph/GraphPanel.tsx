import {
  type KeyboardEvent,
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CameraState } from "sigma/types";
import type { GraphSet } from "../../api/generated/shapes";
import { noticeText } from "../../features/datasources/reasons";
import { translate, useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useEscapeLayer } from "../../lib/layers";
import { useLinkValues } from "../DataLinkViews";
import { graphValue, linksForRecord } from "../dataLinks";
import { isMultiVariable, setVariableFromClick, setVariableValues, usePanelHost } from "../host";
import type { PanelGraph, PanelProps } from "../types";
import { explorationQuery, MAX_QUERY_NODES, propertyText } from "./adapter";
import { HiddenList, PinMarks, SelectionBar } from "./canvas/CanvasParts";
import { type CanvasMenu, type CanvasMenuEntry, ContextMenu } from "./canvas/ContextMenu";
import { CARD_DELAY_MS } from "./canvas/cardContent";
import { EdgeSheet } from "./canvas/EdgeSheet";
import {
  hide as hideIn,
  pinUpTo,
  release as releaseIn,
  show as showIn,
  stateFromEdits,
} from "./canvas/edits";
import { InfoCard } from "./canvas/InfoCard";
import {
  edgeIdOf,
  edgeIndex,
  fixedIndexes,
  hiddenIndexes,
  idsOf,
  nodeIndexOf,
  pinnedForLayouts,
} from "./canvas/indexes";
import { canvasKey, pressOf, timeSequence } from "./canvas/keys";
import {
  MINIMAP_HEIGHT,
  MINIMAP_MIN_HEIGHT,
  MINIMAP_MIN_WIDTH,
  MINIMAP_WIDTH,
  Minimap,
} from "./canvas/Minimap";
import { SearchBox } from "./canvas/SearchBox";
import { DEFAULT_SCOPE, type SearchHit, type SearchScope, searchGraph } from "./canvas/search";
import {
  type AreaMode,
  allNodes,
  applyArea,
  edgesOfType,
  edgesWithin,
  inverted,
  neighboursOf,
  shownCounts,
  withoutHidden,
} from "./canvas/selection";
import { NARROW_CANVAS_PX, ToolStrip } from "./canvas/ToolStrip";
import { useBoxSize } from "./canvas/useBoxSize";
import { useHistory } from "./canvas/useHistory";
import { useViewEdits } from "./canvas/useViewEdits";
import { type GraphPalette, prefersReducedMotion, readPalette, useThemeVersion } from "./colors";
import { hierarchyElk, useViewDirection } from "./direction";
import type { DrawStyle } from "./drawing";
import { ExplorerBar } from "./ExplorerBar";
import { MAIN_THREAD_ELK_LIMIT } from "./elkLayout";
import { GraphState } from "./GraphState";
import { GraphTable } from "./GraphTable";
import { type GraphDisplay, GraphToolbar, TOOLBAR_DIRECTIONS } from "./GraphToolbar";
import {
  capValues,
  labelCounts,
  nodeIds,
  onlySelection,
  type PinnedNode,
  pinnedGraph,
  pinOf,
  selectionValues,
  withoutLabels,
} from "./inspect";
import { Legend } from "./Legend";
import type { LayoutMode } from "./layoutProtocol";
import {
  COMMUNITY_LIMIT,
  type Communities,
  communities,
  communitiesFrom,
  components,
} from "./metrics";
import { buildGraphModel, edgeTimes, edgeWidths, GRAPH_COLORS, nodeSizes } from "./model";
import { NodeSheet, type PinEntry } from "./NodeSheet";
import {
  AUTO_CLUSTER_EDGES,
  AUTO_CLUSTER_NODES,
  type ElkSettings,
  type GraphPanelOptions,
} from "./options";
import { labelGroupOf, type PropertyPaint, propertyPaint } from "./paint";
import { countText } from "./plural";
import type { CanvasHandle, CanvasTarget, CanvasTool, NodeMove } from "./SigmaCanvas";
import { labelShapeOf } from "./shapes";
import { useShortPanel } from "./shortPanel";
import type { KeepOut } from "./spread";
import { type Explorer, type ExplorerStep, useExplorer } from "./useExplorer";
import { type LayoutState, useGraphLayout } from "./useGraphLayout";
import {
  allVisible,
  buildView,
  type GraphView,
  labelRanks,
  shouldCluster,
  timeSteps,
  type Visibility,
  visibleAt,
} from "./view";
import { MAX_VIEW_IDS, usePanelViewState } from "./viewState";
import "./graph.css";
import "../panels.css";
import { isInsideSelectPopup } from "../../components/Select";

/** Sigma loads with the first drawn graph, so the start bundle does not carry WebGL code. */
const LazySigmaCanvas = lazy(() =>
  import("./SigmaCanvas").then((module) => ({ default: module.SigmaCanvas })),
);

/** Whether this browser can draw with WebGL 2, which the renderer needs. */
function canDraw(): boolean {
  if (typeof document === "undefined" || /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}

const DRAWABLE = canDraw();

/**
 * A hierarchy lays out at most this many nodes: beyond it the layered layout takes seconds, so
 * the panel offers the network instead (Graph board, frame 3).
 */
export const HIERARCHY_LIMIT = 2_000;
/** The smallest node of a hierarchy, in px: a leaf stays a node, not a dot. */
export const HIERARCHY_MIN_NODE_SIZE = 7;

interface GraphPanelProps extends PanelProps<GraphPanelOptions> {
  mode: LayoutMode;
}

/**
 * The network and hierarchy panels: a graph drawn with WebGL, the same graph as tables for
 * screen readers (and where WebGL is missing), selection with the side sheet, pins, the explorer,
 * the time slider and graph metrics. The explorer needs the organization; elsewhere the panel
 * draws what it has.
 */
export function GraphPanel(props: GraphPanelProps) {
  const { t } = useI18n();
  const host = usePanelHost();
  const graphs = props.graphs ?? [];
  if (graphs.length === 0) {
    return (
      <GraphState icon="network" empty>
        {t("dashboards.panels.empty.noData")}
      </GraphState>
    );
  }
  if (host.orgId !== undefined) {
    return <ExplorerGraphPanel {...props} graphs={graphs} orgId={host.orgId} />;
  }
  return <GraphPanelBody {...props} graphs={graphs} explorer={null} />;
}

function ExplorerGraphPanel(
  props: GraphPanelProps & { graphs: readonly PanelGraph[]; orgId: string },
) {
  const explorer = useExplorer(
    props.orgId,
    props.graphs,
    props.timeRange,
    props.options.expandLimit,
  );
  return <GraphPanelBody {...props} explorer={explorer} />;
}

const NO_STEPS: readonly ExplorerStep[] = [];
const NO_PINS: ReadonlyMap<string, PinnedNode> = new Map();

interface BodyProps extends GraphPanelProps {
  graphs: readonly PanelGraph[];
  explorer: Explorer | null;
}

/** Turns the panel's results and options into what is drawn; memoized on what each step uses. */
function useGraph(
  sets: readonly GraphSet[],
  options: GraphPanelOptions,
  mode: LayoutMode,
  open: ReadonlySet<number>,
  unclustered: boolean,
  texts: { cluster: (label: string, members: number) => string; unlabelled: string },
  found: Communities | null,
) {
  const model = useMemo(
    () => buildGraphModel(sets, { nodeLimit: options.nodeLimit, caption: options.caption }),
    [sets, options.nodeLimit, options.caption],
  );
  const parts = useMemo(() => components(model), [model]);
  // In a hierarchy most nodes are leaves of degree one: sized by degree they shrank to dots
  // beside their parents, so the layers start at a size a leaf stays visible at.
  const sizes = useMemo(() => {
    const out = nodeSizes(model, options.sizeBy, options.sizeMin, options.sizeMax);
    return mode === "hierarchy"
      ? out.map((size) => Math.max(size, Math.min(HIERARCHY_MIN_NODE_SIZE, options.sizeMax)))
      : out;
  }, [model, options.sizeBy, options.sizeMin, options.sizeMax, mode]);
  const widths = useMemo(
    () => edgeWidths(model, options.edgeWidthBy),
    [model, options.edgeWidthBy],
  );
  const {
    labelColors,
    labelShapes,
    colorBy,
    colorProperty,
    colorScheme,
    colorRange,
    colorMin,
    colorMax,
  } = options;
  const labelGroup = useMemo(() => labelGroupOf(model, labelColors), [model, labelColors]);
  const labelShape = useMemo(() => labelShapeOf(model, labelShapes), [model, labelShapes]);
  const property = useMemo(
    () =>
      colorBy === "property"
        ? propertyPaint(model, { colorProperty, colorScheme, colorRange, colorMin, colorMax })
        : null,
    [model, colorBy, colorProperty, colorScheme, colorRange, colorMin, colorMax],
  );
  const groups = useMemo(() => {
    if (property !== null) return property.groups;
    const of =
      colorBy === "component"
        ? parts.of
        : colorBy === "community" && found !== null && found.of.length === model.nodes.length
          ? found.of
          : null;
    return Int32Array.from(model.nodes, (node, i) =>
      of === null ? labelGroup(node.label) : (of[i] ?? 0) % GRAPH_COLORS,
    );
  }, [model, parts, found, colorBy, property, labelGroup]);
  const cluster =
    mode === "force" &&
    !unclustered &&
    shouldCluster(
      options.cluster,
      { nodes: model.nodes.length, edges: model.edges.length },
      { nodes: AUTO_CLUSTER_NODES, edges: AUTO_CLUSTER_EDGES },
    );
  const { cluster: clusterText, unlabelled } = texts;
  const view = useMemo(
    () =>
      buildView(model, {
        sizes,
        widths,
        groups,
        cluster,
        open,
        clusterCaption: clusterText,
        unlabelled,
        labelGroup,
        labelShape,
      }),
    [model, sizes, widths, groups, cluster, open, clusterText, unlabelled, labelGroup, labelShape],
  );
  const times = useMemo(
    () => edgeTimes(model, options.timeProperty),
    [model, options.timeProperty],
  );
  const steps = useMemo(() => timeSteps(times), [times]);
  const ranks = useMemo(() => labelRanks(view), [view]);
  return { model, parts, view, times, steps, ranks, property, labelGroup, labelShape };
}

function GraphPanelBody({ graphs, options, title, mode, explorer }: BodyProps) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const linkValues = useLinkValues();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  // Whether the lazily loaded canvas is there: the minimap and the pin marks follow it then.
  const [canvasReady, setCanvasReady] = useState(false);

  // The camera outlives the canvas: a view with other nodes (a loaded neighbourhood, an opened
  // group) draws in a new one, and the zoom and centre stay where the user left them.
  const camera = useRef<CameraState | null>(null);
  const number = new Intl.NumberFormat(language);
  const [display, setDisplay] = useState<GraphDisplay>(DRAWABLE ? "graph" : "table");
  const [layout, setLayout] = useState<LayoutMode>(mode);
  // The hierarchy's direction, chosen per view; it starts where the panel's options put it.
  const [direction, setDirection] = useViewDirection(options.elkDirection);
  // The explorer is the viewer's: on as the panel says, switched for this view only.
  const [exploring, setExploring] = useState(options.explorer);
  // Selected view keys in the order they were selected; the cursor is the node the keyboard
  // moves from and the details are of.
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [only, setOnly] = useState(false);
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<string>>(new Set());
  // The history of the view (Graph 0.8.1 board, frame 6) and what the person changed about it:
  // pinned nodes with their places, and what they hid. In the panel editor the pinned nodes are
  // the panel's options, saved for everyone.
  const history = useHistory();
  const editOptions = host.editOptions;
  const viewEdits = useViewEdits({
    panel: options.pinned,
    editOptions:
      editOptions === undefined ? undefined : (pinned) => editOptions({ ...options, pinned }),
    record: (label, undo, redo) => history.record(label, undo, redo),
  });
  const pins = viewEdits.ids;
  // Each pinned node as it was when pinned (kept while its step is gone).
  const [pinned, setPinned] = useState<ReadonlyMap<string, PinnedNode>>(NO_PINS);
  // Selected edges (view keys); the edge whose sheet is open; the tool on the canvas.
  const [edgeSelection, setEdgeSelection] = useState<readonly string[]>([]);
  const [sheetEdge, setSheetEdge] = useState<string | null>(null);
  const [tool, setTool] = useState<{ name: CanvasTool; locked: boolean }>({
    name: "pointer",
    locked: false,
  });
  // The info card (after the pointer rested), the open context menu, the search, the minimap
  // (null: as the panel's size suggests) and the walk along a node's edges (K).
  const [card, setCard] = useState<CanvasTarget | null>(null);
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const menuReturn = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState<{
    query: string;
    scope: SearchScope;
    current: number;
  } | null>(null);
  const [minimap, setMinimap] = useState<boolean | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [edgeWalk, setEdgeWalk] = useState<{ node: number; at: number } | null>(null);
  const stageSize = useBoxSize();
  // Whether the focus is inside the panel; Escape clears the selection only then.
  const rootRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const short = useShortPanel(rootRef);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onIn = () => setFocused(true);
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && (root.contains(next) || isInsideSelectPopup(next)))) {
        setFocused(false);
      }
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut);
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut);
    };
  }, []);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [unclustered, setUnclustered] = useState(false);
  const [timeIndex, setTimeIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [gestureHint, setGestureHint] = useState<"wheel" | "touch" | null>(null);
  const [found, setFound] = useState<Communities | null>(null);
  const themeVersion = useThemeVersion();
  const [palette, setPalette] = useState<GraphPalette | null>(null);

  const explorerOn = explorer !== null && exploring && explorer.unavailable === null;
  const steps = explorerOn ? explorer.steps : NO_STEPS;
  // Pins kept from an earlier visit show whether or not the explorer is on.
  const restored = explorer?.restored ?? null;
  const fromResults = useSameList([
    ...graphs.map((g) => g.graph),
    ...steps.map((s) => s.graph),
    ...(restored === null ? [] : [restored]),
  ]);
  // Pinned nodes stay when their step is taken back; edges only to nodes still there.
  const pinSet = useMemo(() => {
    const kept = new Map<string, PinnedNode>();
    for (const id of pins) {
      const pin = pinned.get(id);
      if (pin !== undefined) kept.set(id, pin);
    }
    return pinnedGraph(kept, nodeIds(fromResults));
  }, [pins, pinned, fromResults]);
  const sets = useMemo(
    () => (pinSet === null ? fromResults : [...fromResults, pinSet]),
    [fromResults, pinSet],
  );
  // Stable per language, so the view is not rebuilt on every render.
  const texts = useMemo(() => {
    const format = new Intl.NumberFormat(language);
    return {
      cluster: (label: string, members: number) =>
        translate(language, "graph.cluster.caption", { label, count: format.format(members) }),
      unlabelled: translate(language, "graph.cluster.unlabelled"),
    };
  }, [language]);
  const graph = useGraph(sets, options, layout, open, unclustered, texts, found);
  const { model, parts, view, times, ranks } = graph;
  const hierarchyTooLarge = layout === "hierarchy" && model.nodes.length > HIERARCHY_LIMIT;

  // Larger graphs from one Neo4j or Memgraph source the viewer may query: the database's own
  // algorithm (GDS, MAGE), when it has one.
  const databaseSource =
    explorer !== null &&
    explorer.unavailable === null &&
    graphs.every((g) => g.datasourceId === explorer.datasourceId)
      ? explorer.datasourceId
      : null;
  const [fromDatabase, setFromDatabase] = useState(false);
  const askDatabase = useEffectEvent((ids: string[], signal: AbortSignal) =>
    explorer === null ? Promise.resolve(null) : explorer.communities(ids, signal),
  );

  // Communities in the browser for graphs small enough to compute them without a noticeable
  // pause; above that by the database where it can, else none.
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setFound(null);
    setFromDatabase(false);
    if (model.nodes.length <= COMMUNITY_LIMIT) {
      void communities(model).then((result) => {
        if (current) setFound(result);
      });
    } else if (databaseSource !== null) {
      void askDatabase(
        model.nodes.map((node) => node.id),
        controller.signal,
      ).then((assigned) => {
        if (current && assigned !== null && assigned.size > 0) {
          setFound(communitiesFrom(model, assigned));
          setFromDatabase(true);
        }
      });
    }
    return () => {
      current = false;
      controller.abort();
    };
  }, [model, databaseSource]);

  // Colors of the theme, read again when it changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: themeVersion only triggers a new read
  useEffect(() => {
    if (stageRef.current !== null) setPalette(readPalette(stageRef.current));
  }, [themeVersion, display, hierarchyTooLarge]);

  useEffect(() => {
    if (gestureHint === null) return;
    const timer = setTimeout(() => setGestureHint(null), 2_000);
    return () => clearTimeout(timer);
  }, [gestureHint]);

  const viewIndex = useMemo(() => new Map(view.nodes.map((node, i) => [node.key, i])), [view]);
  const selectedList = useMemo(
    () => selection.flatMap((key) => (viewIndex.has(key) ? [viewIndex.get(key) as number] : [])),
    [selection, viewIndex],
  );
  const selected = useMemo(() => new Set(selectedList), [selectedList]);
  const cursorIndex = cursor === null ? null : (viewIndex.get(cursor) ?? null);
  const primary =
    cursorIndex !== null && selected.has(cursorIndex) ? cursorIndex : (selectedList.at(-1) ?? null);

  const edgeViewIndex = useMemo(() => new Map(view.edges.map((edge, i) => [edge.key, i])), [view]);
  const selectedEdges = useMemo(
    () =>
      new Set(
        edgeSelection.flatMap((key) =>
          edgeViewIndex.has(key) ? [edgeViewIndex.get(key) as number] : [],
        ),
      ),
    [edgeSelection, edgeViewIndex],
  );
  const sheetEdgeIndex = sheetEdge === null ? null : (edgeViewIndex.get(sheetEdge) ?? null);

  const { hidden: hiddenIds, hiddenEdges: hiddenEdgeIds } = viewEdits.edits;
  // What is hidden in this result is listed and counted; entries for nodes and edges the result
  // no longer has rest, counted apart, until they come back.
  const edgeById = useMemo(() => edgeIndex(model), [model]);
  const hiddenHere = useMemo(
    () => ({
      nodes: hiddenIds.filter((id) => model.index.has(id)),
      edges: hiddenEdgeIds.filter((id) => edgeById.has(id)),
    }),
    [model, edgeById, hiddenIds, hiddenEdgeIds],
  );
  const hiddenResting =
    hiddenIds.length + hiddenEdgeIds.length - hiddenHere.nodes.length - hiddenHere.edges.length;
  const hiddenEntries = [
    ...hiddenHere.nodes.map((id) => ({ id, caption: hiddenCaption(id, "node") })),
    ...hiddenHere.edges.map((id) => ({ id, caption: hiddenCaption(id, "edge") })),
  ];
  const hidden = useMemo(
    () => hiddenIndexes(model, view, hiddenIds, hiddenEdgeIds),
    [model, view, hiddenIds, hiddenEdgeIds],
  );
  const timeAt = timeIndex === null ? null : (graph.steps[timeIndex] ?? null);
  // What the time slider and the legend leave, before the person's hiding: the counts of
  // "10 of 15 nodes visible" count from here.
  const unhidden = useMemo(() => {
    const atTime = timeAt === null ? allVisible(view) : visibleAt(model, view, times, timeAt);
    return withoutLabels(model, view, atTime, hiddenLabels);
  }, [model, view, times, timeAt, hiddenLabels]);
  const visibility = useMemo(() => {
    const shown = withoutHidden(view, unhidden, hidden.nodes, hidden.edges);
    return only && selected.size > 0 ? onlySelection(view, shown, selected) : shown;
  }, [view, unhidden, hidden, only, selected]);
  // Pinned nodes with a place, by view index: the canvas holds them there.
  const fixed = useMemo(
    () => fixedIndexes(model, view, viewEdits.places),
    [model, view, viewEdits.places],
  );
  const pinMarkNodes = useMemo(
    () => [...fixed.keys()].filter((i) => visibility.nodes[i] === 1),
    [fixed, visibility],
  );

  const neighbours = useMemo(() => {
    const set = new Set<number>();
    if (selected.size > 0) {
      for (const edge of view.edges) {
        if (selected.has(edge.source)) set.add(edge.target);
        if (selected.has(edge.target)) set.add(edge.source);
      }
    }
    return set;
  }, [view, selected]);

  const style = useMemo<DrawStyle>(
    () => ({
      arrows: options.arrows,
      edgeLabels: options.edgeLabels,
      labels: options.labels,
      labelTop: options.labelTop,
      ramp: options.colorScheme === "values" ? "blues" : options.colorScheme,
    }),
    [options.arrows, options.edgeLabels, options.labels, options.labelTop, options.colorScheme],
  );

  // Escape clears the selection only while the panel has the focus, and the selection does not
  // hold back the shell's shortcuts: Ctrl+K, ?, / and F6 still work after clicking a node. While
  // the search is open, Escape closes it and leaves the selection (its jump just made one).
  useEscapeLayer(
    focused && search === null && (selected.size > 0 || selectedEdges.size > 0),
    () => clearSelection(),
    { blocking: false },
  );
  // The info card, the search, a selection tool and the walk along edges close before the
  // selection does.
  useEscapeLayer(
    focused && (card !== null || search !== null || tool.name !== "pointer" || edgeWalk !== null),
    () => {
      if (card !== null) setCard(null);
      else if (search !== null) {
        setSearch(null);
        stageRef.current?.focus();
      } else if (tool.name !== "pointer") {
        canvasRef.current?.areaKey("cancel", false);
        setTool({ name: "pointer", locked: false });
      } else setEdgeWalk(null);
    },
  );

  // The viewer's own pins and selection of this dashboard panel, kept on the server. The panel
  // editor's preview never reads or writes it: there, pins are the panel's own.
  const kept = usePanelViewState(host.orgId, editOptions === undefined ? host.view : undefined);
  const [restoredState, setRestoredState] = useState(false);
  useEffect(() => {
    // Pins that need fetching wait until the panel knows whether the source may be queried.
    if (restoredState || !kept.settled || explorer?.unavailable === "loading") return;
    setRestoredState(true);
    const state = kept.state;
    // The panel's own pinned nodes may come from explorer steps too: fetched like the person's.
    const ofPanel = options.pinned.map((place) => place.id);
    if (state !== null && editOptions === undefined) {
      viewEdits.restore(state);
      setSelection(state.selected.map((id) => `n:${id}`));
    }
    const released = new Set(state?.released ?? []);
    const wanted = [
      ...new Set([...ofPanel.filter((id) => !released.has(id)), ...(state?.pinned ?? [])]),
    ];
    const missing = wanted.filter((id) => !model.index.has(id)).slice(0, MAX_VIEW_IDS);
    if (missing.length > 0 && explorer !== null) explorer.restore(missing);
  }, [
    restoredState,
    kept.settled,
    kept.state,
    model,
    explorer,
    options.pinned,
    viewEdits,
    editOptions,
  ]);
  // A pinned node's data, once it is in the model (pinned now, or kept from an earlier visit).
  useEffect(() => {
    const lacking = pins.filter((id) => !pinned.has(id) && model.index.has(id));
    if (lacking.length === 0) return;
    setPinned((current) => {
      const next = new Map(current);
      for (const id of lacking) {
        const pin = pinOf(model, model.index.get(id) as number);
        if (pin !== null) next.set(id, pin);
      }
      return next;
    });
  }, [pins, pinned, model]);
  const keptSelection = useMemo(
    () => selection.flatMap((key) => (key.startsWith("n:") ? [key.slice(2)] : [])),
    [selection],
  );
  const keptEdits = viewEdits.edits;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `kept.keep` sends; the state decides when
  useEffect(() => {
    if (restoredState && editOptions === undefined) {
      kept.keep(stateFromEdits(keptEdits, keptSelection));
    }
  }, [restoredState, keptEdits, keptSelection]);

  const variable =
    options.variable !== "" &&
    (host.variables?.names.includes(options.variable) === true ||
      isMultiVariable(host, options.variable))
      ? options.variable
      : null;
  const multi = variable !== null && isMultiVariable(host, variable);

  function modelIndex(index: number): number | null {
    const node = view.nodes[index];
    return node !== undefined && node.node >= 0 ? node.node : null;
  }

  function describeNode(index: number): string {
    const node = view.nodes[index];
    if (node === undefined) return "";
    if (node.node < 0) {
      return t("graph.announce.cluster", { name: node.caption });
    }
    const data = model.nodes[node.node];
    return t("graph.announce.node", {
      name: node.caption,
      labels: data?.labels.join(", ") || t("graph.cluster.unlabelled"),
      count: number.format(data?.degree ?? 0),
    });
  }

  function clearSelection() {
    setSelection([]);
    setEdgeSelection([]);
    setSheetEdge(null);
    setEdgeWalk(null);
    setCursor(null);
    setOnly(false);
    setAnnouncement(t("graph.announce.cleared"));
  }

  /** Selects one node (replacing the selection), or adds it to or takes it out of it. */
  function select(index: number | null, additive = false) {
    if (index === null) {
      if (!additive) clearSelection();
      return;
    }
    const node = view.nodes[index];
    if (node === undefined) return;
    setCursor(node.key);
    if (additive) {
      const has = selection.includes(node.key);
      setSelection(has ? selection.filter((k) => k !== node.key) : [...selection, node.key]);
      setAnnouncement(
        has
          ? t("graph.announce.deselected", { name: node.caption })
          : t("graph.announce.added", {
              name: node.caption,
              count: number.format(selection.length + 1),
            }),
      );
    } else {
      setSelection([node.key]);
      setEdgeSelection([]);
      setSheetEdge(null);
      setAnnouncement(describeNode(index));
    }
    canvasRef.current?.reveal(index);
  }

  function setVariableFrom(index: number) {
    const m = modelIndex(index);
    const data = m === null ? undefined : model.nodes[m];
    if (variable === null || data === undefined) return;
    const value =
      options.variableProperty === ""
        ? data.id
        : propertyText(data.properties[options.variableProperty]);
    const outcome = setVariableFromClick(host, variable, value);
    setAnnouncement(
      outcome === "set"
        ? t("graph.announce.variable", { name: variable, value })
        : t("graph.announce.variableRefused", { name: variable, value }),
    );
  }

  const selectionModel = selectedList.flatMap((i) => {
    const m = modelIndex(i);
    return m === null ? [] : [m];
  });
  const { values, capped } = capValues(
    multi
      ? selectionValues(model, selectionModel, options.variableProperty).filter(
          (value) => host.variables?.accepts(variable as string, value) === true,
        )
      : [],
  );

  function setVariableValuesFromSelection() {
    if (variable === null || values.length === 0) return;
    const outcome = setVariableValues(host, variable, values);
    setAnnouncement(
      outcome === "set"
        ? t("graph.announce.variableMany", {
            name: variable,
            count: number.format(values.length),
          })
        : t("graph.announce.variableManyRefused", { name: variable }),
    );
  }

  /** The newest step of a node, for "load more". */
  function lastStepOf(id: string): ExplorerStep | undefined {
    return steps.findLast((s) => s.nodeId === id);
  }

  /** Whether the node has neighbours not loaded yet (unknown counts as yes). */
  function hasMore(step: ExplorerStep | undefined): boolean {
    return step === undefined || step.total === null || step.skipped + step.loaded < step.total;
  }

  /** Loads the node's neighbours, or its next ones when a step already loaded some. */
  function expand(index: number) {
    const m = modelIndex(index);
    const data = m === null ? undefined : model.nodes[m];
    if (!explorerOn || data === undefined || explorer.pending !== null) return;
    const step = lastStepOf(data.id);
    if (step === undefined) explorer.expand(data.id, data.caption);
    else if (hasMore(step)) explorer.more(step);
  }

  /** A click or Enter on a node: open a group, or the panel's click action. */
  function activate(index: number) {
    const node = view.nodes[index];
    if (node === undefined) return;
    if (node.node < 0) {
      openGroup(node.cluster, node.caption);
      return;
    }
    if (options.clickAction === "variable") setVariableFrom(index);
    if (options.clickAction === "expand") expand(index);
  }

  /** Opens a group, as a step of the history. */
  function openGroup(cluster: number, caption: string) {
    if (open.has(cluster)) return;
    const before = open;
    const after = new Set([...open, cluster]);
    setOpen(after);
    setAnnouncement(t("graph.announce.opened", { name: caption }));
    history.record(
      t("graphCanvas.step.opened", { name: caption }),
      () => setOpen(before),
      () => setOpen(after),
    );
  }

  function closeGroups() {
    const before = open;
    const after: ReadonlySet<number> = new Set();
    setOpen(after);
    history.record(
      t("graphCanvas.step.closed"),
      () => setOpen(before),
      () => setOpen(after),
    );
  }

  function pick(index: number | null, additive: boolean) {
    select(index, additive);
    if (index === null || additive) return;
    // A click whose action cannot happen here (no explorer, no rights, TigerGraph) opens the
    // details instead of doing nothing.
    const actionless = options.clickAction === "expand" && !explorerOn;
    setSheetOpen(options.clickAction === "details" || options.clickDetails || actionless);
    activate(index);
  }

  /** "Edge PLACED, Anna Weber → Gateway G1", or what an edge between groups stands for. */
  function describeEdge(index: number): string {
    const edge = view.edges[index];
    if (edge === undefined) return "";
    const from = view.nodes[edge.source]?.caption ?? "";
    const to = view.nodes[edge.target]?.caption ?? "";
    const data = edge.edge >= 0 ? model.edges[edge.edge] : undefined;
    return data === undefined
      ? t("graphCanvas.edge.merged", { count: number.format(edge.count), from, to })
      : t("graphCanvas.edge.named", { type: data.type, from, to });
  }

  /** Selects an edge with its sheet (replacing the selection), or adds it or takes it out. */
  function pickEdge(index: number, additive = false) {
    const edge = view.edges[index];
    if (edge === undefined) return;
    if (additive) {
      const has = edgeSelection.includes(edge.key);
      setEdgeSelection(
        has ? edgeSelection.filter((key) => key !== edge.key) : [...edgeSelection, edge.key],
      );
      if (!has) setSheetEdge(edge.key);
      else if (sheetEdge === edge.key) setSheetEdge(null);
      setAnnouncement(
        t(has ? "graphCanvas.announce.edgeOut" : "graphCanvas.announce.edgeIn", {
          edge: describeEdge(index),
        }),
      );
      return;
    }
    setSelection([]);
    setEdgeSelection([edge.key]);
    setSheetEdge(edge.key);
    setSheetOpen(true);
    setAnnouncement(t("graphCanvas.announce.edge", { edge: describeEdge(index) }));
  }

  /** "5 nodes, 4 edges": what a selection of nodes holds (edges with both ends in it). */
  function selectionText(nodes: ReadonlySet<number>, extraEdges = 0): string {
    return t("graphCanvas.selection.count", {
      nodes: countText(t, language, "node", nodes.size),
      edges: countText(
        t,
        language,
        "edge",
        edgesWithin(view, visibility, nodes).length + extraEdges,
      ),
    });
  }

  /** Replaces the selection with these nodes (view indexes) and says what it holds. */
  function selectMany(indexes: readonly number[]) {
    const keys = [
      ...new Set(
        indexes.flatMap((i) => {
          const key = view.nodes[i]?.key;
          return key === undefined ? [] : [key];
        }),
      ),
    ];
    setSelection(keys);
    setEdgeSelection([]);
    setSheetEdge(null);
    setCursor(keys.at(-1) ?? null);
    setAnnouncement(
      keys.length === 0
        ? t("graph.announce.cleared")
        : t("graphCanvas.announce.selected", { what: selectionText(new Set(indexes)) }),
    );
  }

  function selectArea(nodes: readonly number[], mode: AreaMode) {
    const keys = nodes.flatMap((i) => {
      const key = view.nodes[i]?.key;
      return key === undefined ? [] : [key];
    });
    const next = applyArea(selection, keys, mode);
    selectMany(next.flatMap((key) => (viewIndex.has(key) ? [viewIndex.get(key) as number] : [])));
    if (!tool.locked) setTool({ name: "pointer", locked: false });
  }

  const invertSelection = () => selectMany(inverted(view, visibility, selected));
  const selectAll = () => selectMany(allNodes(view, visibility));
  const addNeighbours = () =>
    selectMany([...selectedList, ...neighboursOf(view, visibility, selected)]);

  /** "Show only this node and its neighbours": they become the selection, shown alone. */
  function onlyWithNeighbours(index: number) {
    const around = neighboursOf(view, visibility, new Set([index]));
    selectMany([index, ...around]);
    if (!only) {
      setOnly(true);
      history.record(
        t("graphCanvas.step.only"),
        () => setOnly(false),
        () => setOnly(true),
      );
    }
  }

  /** The visible edges at a node, for the walk along them (K). */
  function edgesAt(node: number): number[] {
    const out: number[] = [];
    view.edges.forEach((edge, i) => {
      if (visibility.edges[i] === 1 && (edge.source === node || edge.target === node)) out.push(i);
    });
    return out;
  }

  /** A caption for a hidden node or edge id, as the list of hidden elements names it. */
  function hiddenCaption(id: string, kind: "node" | "edge"): string {
    if (kind === "node") {
      const m = model.index.get(id);
      return (m === undefined ? undefined : model.nodes[m]?.caption) ?? id;
    }
    const at = edgeById.get(id);
    const data = at === undefined ? undefined : model.edges[at];
    if (data === undefined) return id;
    return t("graphCanvas.edge.named", {
      type: data.type,
      from: model.nodes[data.source]?.caption ?? "",
      to: model.nodes[data.target]?.caption ?? "",
    });
  }

  /** Hides nodes (a group: all its members) and edges (view indexes), as one step. */
  function hideItems(nodes: readonly number[], edges: readonly number[] = []) {
    const nodeIds = nodes.flatMap((i) => idsOf(model, view, i));
    const edgeIds = edges.flatMap((i) => {
      const id = edgeIdOf(model, view, i);
      return id === null ? [] : [id];
    });
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    const next = hideIn(viewEdits.now(), nodeIds, edgeIds);
    if (next.hidden.length > MAX_VIEW_IDS || next.hiddenEdges.length > MAX_VIEW_IDS) {
      setAnnouncement(t("graphCanvas.announce.hideLimit", { max: number.format(MAX_VIEW_IDS) }));
      return;
    }
    const count = nodes.length + edges.length;
    const first = nodes[0];
    const label =
      count > 1
        ? t("graphCanvas.step.hidden", { count: number.format(count) })
        : t("graphCanvas.step.hiddenOne", {
            name:
              first === undefined
                ? describeEdge(edges[0] ?? -1)
                : (view.nodes[first]?.caption ?? ""),
          });
    if (!viewEdits.change(next, label)) return;
    // Hidden elements leave the selection.
    const goneNodes = new Set(nodes.map((i) => view.nodes[i]?.key));
    const goneEdges = new Set(edges.map((i) => view.edges[i]?.key));
    setSelection(selection.filter((key) => !goneNodes.has(key)));
    setEdgeSelection(edgeSelection.filter((key) => !goneEdges.has(key)));
    if (sheetEdge !== null && goneEdges.has(sheetEdge)) setSheetEdge(null);
    const after = hiddenIndexes(model, view, next.hidden, next.hiddenEdges);
    const counts = {
      shown: number.format(
        shownCounts(withoutHidden(view, unhidden, after.nodes, after.edges)).nodes,
      ),
      total: number.format(shownCounts(unhidden).nodes),
    };
    setAnnouncement(
      count === 1
        ? t("graphCanvas.announce.hiddenOne", {
            name:
              first === undefined
                ? describeEdge(edges[0] ?? -1)
                : (view.nodes[first]?.caption ?? ""),
            ...counts,
          })
        : t("graphCanvas.announce.hidden", { count: number.format(count), ...counts }),
    );
  }

  /** H: hides the selection (nodes and edges), else the focused node. */
  function hideSelection() {
    if (selectedList.length > 0 || selectedEdges.size > 0) {
      hideItems(selectedList, [...selectedEdges]);
    } else if (cursorIndex !== null) {
      hideItems([cursorIndex]);
    }
  }

  /** Shows hidden nodes and edges again (by id), or all of them, as one step. */
  function showItems(ids?: readonly string[]) {
    const now = viewEdits.now();
    const count = ids?.length ?? now.hidden.length + now.hiddenEdges.length;
    if (count === 0) return;
    const one = ids?.length === 1 ? (ids[0] as string) : null;
    const name = one === null ? "" : hiddenCaption(one, now.hidden.includes(one) ? "node" : "edge");
    const changed = viewEdits.change(
      showIn(now, ids),
      ids === undefined
        ? t("graphCanvas.step.shownAll", { count: number.format(count) })
        : one !== null
          ? t("graphCanvas.step.shownOne", { name })
          : t("graphCanvas.step.shown", { count: number.format(count) }),
    );
    if (changed) {
      setAnnouncement(
        one !== null
          ? t("graphCanvas.announce.shownOne", { name })
          : t("graphCanvas.announce.shown", { count: number.format(count) }),
      );
    }
  }

  /** The node id a view node draws; undefined for a group. */
  function idOf(index: number): string | undefined {
    const m = modelIndex(index);
    return m === null ? undefined : model.nodes[m]?.id;
  }

  /**
   * Pins these nodes (view indexes) where they stand, or releases them when all of them are
   * pinned, as one step. A group cannot be pinned.
   */
  function togglePins(indexes: readonly number[]) {
    const nodes = indexes.flatMap((i) => {
      const id = idOf(i);
      return id === undefined ? [] : [{ i, id }];
    });
    const first = nodes[0];
    if (first === undefined) return;
    const pinnedNow = new Set(pins);
    const name = view.nodes[first.i]?.caption ?? first.id;
    const count = number.format(nodes.length);
    if (nodes.every((node) => pinnedNow.has(node.id))) {
      viewEdits.change(
        releaseIn(
          viewEdits.now(),
          nodes.map((node) => node.id),
          options.pinned,
        ),
        nodes.length === 1
          ? t("graphCanvas.step.released", { name })
          : t("graphCanvas.step.releasedMany", { count }),
      );
      setAnnouncement(
        nodes.length === 1
          ? t("graph.announce.unpinned", { name })
          : t("graphCanvas.announce.releasedMany", { count }),
      );
      return;
    }
    const places = new Map(
      nodes.flatMap((node) => {
        const at = canvasRef.current?.placeOf(node.i) ?? null;
        return at === null ? [] : [[node.id, at] as const];
      }),
    );
    const { edits: next, refused } = pinUpTo(
      viewEdits.now(),
      nodes.map((node) => node.id),
      places,
    );
    const taken = nodes.length - refused.length;
    if (taken === 0) {
      setAnnouncement(t("graphCanvas.announce.pinLimit", { max: number.format(MAX_VIEW_IDS) }));
      return;
    }
    viewEdits.change(
      next,
      taken === 1
        ? t("graphCanvas.step.pinned", { name })
        : t("graphCanvas.step.pinnedMany", { count: number.format(taken) }),
    );
    setAnnouncement(
      refused.length > 0
        ? t("graphCanvas.announce.pinSome", {
            count: number.format(taken),
            left: number.format(refused.length),
            max: number.format(MAX_VIEW_IDS),
          })
        : nodes.length === 1
          ? t("graph.announce.pinned", { name })
          : t("graphCanvas.announce.pinnedMany", { count }),
    );
  }

  /** The side sheet's pin button and its list of pinned nodes, by node id. */
  function togglePin(id: string) {
    const index = nodeIndexOf(model, view, id);
    if (index !== null) {
      togglePins([index]);
      return;
    }
    // A pinned node that is not drawn on its own (inside a group, or its step gone) can only be
    // released.
    if (!pins.includes(id)) return;
    const m = model.index.get(id);
    const name = (m === undefined ? undefined : model.nodes[m]?.caption) ?? id;
    viewEdits.change(
      releaseIn(viewEdits.now(), [id], options.pinned),
      t("graphCanvas.step.released", { name }),
    );
    setAnnouncement(t("graph.announce.unpinned", { name }));
  }

  /** "Release all": every pinned node, the panel's and the person's own, as one step. */
  function releaseAll() {
    if (pins.length === 0) return;
    const count = number.format(pins.length);
    viewEdits.change(
      releaseIn(viewEdits.now(), pins, options.pinned),
      t("graphCanvas.step.releasedMany", { count }),
    );
    setAnnouncement(t("graphCanvas.announce.releasedMany", { count }));
  }

  /** Nodes dragged (or moved with Alt+arrows) are pinned where they were dropped, as one step. */
  function moved(moves: readonly NodeMove[]) {
    const entries = moves.flatMap((move) => {
      const id = idOf(move.node);
      return id === undefined ? [] : [[id, [move.x, move.y] as const] as const];
    });
    const first = moves[0];
    if (entries.length === 0 || first === undefined) return;
    // Beyond the bound of pinned nodes the rest goes back to where the layout put it.
    const { edits: next, refused } = pinUpTo(
      viewEdits.now(),
      entries.map(([id]) => id),
      new Map(entries),
    );
    if (refused.length > 0) canvasRef.current?.placeAgain();
    const taken = entries.length - refused.length;
    if (taken === 0) {
      setAnnouncement(t("graphCanvas.announce.pinLimit", { max: number.format(MAX_VIEW_IDS) }));
      return;
    }
    const name = view.nodes[first.node]?.caption ?? "";
    const count = number.format(taken);
    viewEdits.change(
      next,
      taken === 1
        ? t("graphCanvas.step.moved", { name })
        : t("graphCanvas.step.movedMany", { count }),
    );
    setAnnouncement(
      refused.length > 0
        ? t("graphCanvas.announce.pinSome", {
            count,
            left: number.format(refused.length),
            max: number.format(MAX_VIEW_IDS),
          })
        : taken === 1
          ? t("graphCanvas.announce.moved", { name })
          : t("graphCanvas.announce.movedMany", { count }),
    );
  }

  /** Back to the panel's state: the person's own pins, places and hiding forgotten, one step. */
  function backToPanel() {
    viewEdits.change(
      { pins: [], places: new Map(), hidden: [], hiddenEdges: [], released: [] },
      t("graphCanvas.step.backToPanel"),
    );
    setAnnouncement(t("graphCanvas.step.backToPanel"));
  }

  /** Ctrl+Z: a step being loaded is cancelled; otherwise the newest step of the history goes. */
  function undo(): boolean {
    if (explorerOn && explorer.pending !== null) {
      const name = explorer.pending.caption;
      explorer.undo();
      setAnnouncement(t("graph.announce.undone", { name }));
      return true;
    }
    const step = history.undo();
    if (step === null) return false;
    setAnnouncement(t("graphCanvas.announce.undone", { step: step.label }));
    return true;
  }

  function redo(): boolean {
    const step = history.redo();
    if (step === null) return false;
    setAnnouncement(t("graphCanvas.announce.redone", { step: step.label }));
    return true;
  }

  function toggleOnly() {
    if (selected.size === 0 && !only) return;
    const next = !only;
    setOnly(next);
    history.record(
      t(next ? "graphCanvas.step.only" : "graphCanvas.step.all"),
      () => setOnly(!next),
      () => setOnly(next),
    );
  }

  function chooseTool(name: CanvasTool, locked: boolean) {
    setTool({ name, locked });
    const toolName = t(`graphCanvas.tool.${name}`);
    setAnnouncement(
      locked
        ? t("graphCanvas.tool.locked", { tool: toolName })
        : t("graphCanvas.announce.tool", { tool: toolName }),
    );
  }

  function openSearch() {
    setSearch((current) => current ?? { query: "", scope: DEFAULT_SCOPE, current: -1 });
  }

  /** The search jumps to a hit: shown first when hidden, its group opened, then selected. */
  function jumpTo(at: number) {
    const hit = hits[at];
    if (hit === undefined) return;
    setSearch((current) => (current === null ? current : { ...current, current: at }));
    setAnnouncement(
      t("graphCanvas.announce.hit", {
        at: number.format(at + 1),
        count: number.format(hits.length),
        name: hit.caption,
        label: hit.label === "" ? t("graph.cluster.unlabelled") : hit.label,
      }),
    );
    if (hit.kind === "edge") {
      const data = model.edges[hit.index];
      if (data !== undefined && hiddenEdgeIds.includes(data.id)) showItems([data.id]);
      const index = view.edgeOf[hit.index] ?? -1;
      if (index >= 0) pickEdge(index);
      return;
    }
    const data = model.nodes[hit.index];
    if (data === undefined) return;
    if (hiddenIds.includes(data.id)) showItems([data.id]);
    const node = view.nodes[view.nodeOf[hit.index] ?? -1];
    if (node !== undefined && node.node < 0) openGroup(node.cluster, node.caption);
    setJumpTarget(data.id);
  }

  /** What a hit needs before it can be shown: "hidden", or "in group Supplier". */
  function noteOf(hit: SearchHit): string | null {
    if (hit.kind === "edge") {
      const data = model.edges[hit.index];
      return data !== undefined && hiddenEdgeIds.includes(data.id)
        ? t("graphCanvas.search.hidden")
        : null;
    }
    const data = model.nodes[hit.index];
    if (data !== undefined && hiddenIds.includes(data.id)) return t("graphCanvas.search.hidden");
    const node = view.nodes[view.nodeOf[hit.index] ?? -1];
    return node !== undefined && node.node < 0
      ? t("graphCanvas.search.inGroup", { name: node.caption })
      : null;
  }

  /** Opens the context menu for the focused element, the selection or the canvas (Shift+F10). */
  function menuAtFocus() {
    const box = stageRef.current?.getBoundingClientRect();
    const middle = {
      x: (box?.left ?? 0) + (box?.width ?? 0) / 2,
      y: (box?.top ?? 0) + (box?.height ?? 0) / 2,
    };
    const walked = edgeWalk === null ? undefined : edgesAt(edgeWalk.node)[edgeWalk.at];
    const kind: "node" | "edge" = walked !== undefined ? "edge" : "node";
    const index = walked ?? cursorIndex ?? primary;
    const target = index === null ? null : (canvasRef.current?.targetOf(kind, index) ?? null);
    const at = target === null ? middle : { x: target.x + target.reach, y: target.y };
    openMenu(target ?? (index === null ? null : { kind, index, x: at.x, y: at.y, reach: 0 }), at);
  }

  /** The menu for what lies at `target`: a node of a larger selection opens the selection's. */
  function openMenu(target: CanvasTarget | null, at: { x: number; y: number }) {
    setCard(null);
    menuReturn.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (target === null) {
      setMenu({ kind: "canvas", index: -1, at });
    } else if (target.kind === "edge") {
      setMenu({ kind: "edge", index: target.index, at });
    } else if (selected.has(target.index) && selected.size > 1) {
      setMenu({ kind: "selection", index: target.index, at });
    } else {
      const key = view.nodes[target.index]?.key;
      if (key !== undefined) setCursor(key);
      setMenu({ kind: "node", index: target.index, at });
    }
  }

  // Follows "t" sequences, so their second key reaches the time range (keys.ts).
  const timeKeys = useRef(timeSequence());

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    if (isComposingKey(event)) return;
    // The second key of a "t" sequence belongs to the time range (timeShortcuts.ts).
    if (timeKeys.current({ ...pressOf(event), timeStamp: event.timeStamp })) return;
    const action = canvasKey(pressOf(event), {
      rect: tool.name === "rect",
      walking: edgeWalk !== null,
    });
    if (action === null) return;
    const cursorAt = cursorIndex ?? primary;
    switch (action.kind) {
      case "undo":
        if (undo()) event.preventDefault();
        return;
      case "redo":
        if (redo()) event.preventDefault();
        return;
      case "selectAll":
        event.preventDefault();
        selectAll();
        return;
      case "invert":
        event.preventDefault();
        invertSelection();
        return;
      case "menu":
        event.preventDefault();
        menuAtFocus();
        return;
      case "nudge": {
        // Alt+arrows move the selection or the focused node and pin it there.
        event.preventDefault();
        const nodes = (
          selectedList.length > 0 ? selectedList : cursorAt === null ? [] : [cursorAt]
        ).filter((i) => idOf(i) !== undefined);
        moved(canvasRef.current?.nudge(nodes, action.dx, action.dy) ?? []);
        return;
      }
      case "area":
        // The rectangle with the keyboard: arrows move the corner, Enter sets it and then selects.
        event.preventDefault();
        canvasRef.current?.areaKey(action.key, action.big);
        return;
      case "walkMove":
      case "walkSelect": {
        event.preventDefault();
        if (edgeWalk === null) return;
        const around = edgesAt(edgeWalk.node);
        if (around.length === 0) return;
        if (action.kind === "walkSelect") {
          const edge = around[edgeWalk.at];
          if (edge !== undefined) pickEdge(edge);
          return;
        }
        const at = (edgeWalk.at + action.by + around.length) % around.length;
        setEdgeWalk({ node: edgeWalk.node, at });
        setAnnouncement(
          t("graphCanvas.announce.edgeAt", {
            edge: describeEdge(around[at] as number),
            at: number.format(at + 1),
            count: number.format(around.length),
          }),
        );
        return;
      }
      case "move": {
        event.preventDefault();
        const next = canvasRef.current?.nodeToward(primary, action.direction) ?? null;
        if (next === null) return;
        const node = view.nodes[next];
        if (node === undefined) return;
        if (selection.length > 1) {
          // Several selected: the arrows move the cursor, Space takes it in or out.
          setCursor(node.key);
          setAnnouncement(describeNode(next));
          canvasRef.current?.reveal(next);
        } else {
          select(next);
        }
        return;
      }
      case "activate": {
        if (cursorAt === null) return;
        event.preventDefault();
        const node = view.nodes[cursorAt];
        if (node !== undefined && node.node >= 0 && explorerOn) expand(cursorAt);
        else activate(cursorAt);
        return;
      }
      case "toggleSelect":
        if (cursorAt === null) return;
        event.preventDefault();
        select(cursorAt, true);
        return;
      case "pin":
        if (cursorAt === null) return;
        event.preventDefault();
        togglePins(selected.has(cursorAt) && selectedList.length > 1 ? selectedList : [cursorAt]);
        return;
      case "only":
        event.preventDefault();
        toggleOnly();
        return;
      case "hide":
        event.preventDefault();
        hideSelection();
        return;
      case "showAll":
        event.preventDefault();
        showItems();
        return;
      case "neighbours":
        event.preventDefault();
        addNeighbours();
        return;
      case "walk":
        event.preventDefault();
        walkEdges(cursorAt);
        return;
      case "tool":
        event.preventDefault();
        chooseTool(action.tool, false);
        return;
      case "search":
        event.preventDefault();
        openSearch();
        return;
      case "card":
        event.preventDefault();
        toggleCard(cursorAt);
        return;
      case "minimap":
        event.preventDefault();
        setMinimap(!minimapOpen);
        return;
      case "view":
        event.preventDefault();
        setDisplay("table");
        return;
      case "zoom":
        event.preventDefault();
        canvasRef.current?.zoom(action.factor);
        return;
      case "fit":
        event.preventDefault();
        canvasRef.current?.reset();
        return;
    }
  }

  /** K: to the edges of the focused node, and back. */
  function walkEdges(cursorAt: number | null) {
    if (edgeWalk !== null) {
      setEdgeWalk(null);
      setAnnouncement(describeNode(edgeWalk.node));
      return;
    }
    if (cursorAt === null) return;
    const around = edgesAt(cursorAt);
    if (around.length === 0) {
      setAnnouncement(t("graphCanvas.announce.noEdges"));
      return;
    }
    setEdgeWalk({ node: cursorAt, at: 0 });
    setAnnouncement(
      t("graphCanvas.announce.edgeAt", {
        edge: describeEdge(around[0] as number),
        at: number.format(1),
        count: number.format(around.length),
      }),
    );
  }

  /** I: the info card of the focused node or edge, or away again. */
  function toggleCard(cursorAt: number | null) {
    if (card !== null) {
      setCard(null);
      return;
    }
    const walked = edgeWalk === null ? undefined : edgesAt(edgeWalk.node)[edgeWalk.at];
    const target =
      walked !== undefined
        ? canvasRef.current?.targetOf("edge", walked)
        : cursorAt === null
          ? null
          : canvasRef.current?.targetOf("node", cursorAt);
    setCard(target ?? null);
  }

  // Announces what a finished step loaded, once per step (not again when a later one is taken
  // back or the step is put back by "Redo").
  const announcedSteps = useRef(new Set<number>());
  const newest = explorer?.steps.at(-1);
  useEffect(() => {
    if (newest === undefined || announcedSteps.current.has(newest.id)) return;
    announcedSteps.current.add(newest.id);
    setAnnouncement(
      newest.total === null
        ? t("graph.announce.loaded", { name: newest.caption, count: newest.loaded })
        : t("graph.announce.loadedOf", {
            name: newest.caption,
            count: newest.skipped + newest.loaded,
            total: newest.total,
          }),
    );
  }, [newest, t]);

  // Explorer steps are steps of the view's history too: Ctrl+Z takes back the newest step,
  // explorer step or not. A step taken back in the step bar leaves the history (decision 5).
  const explorerRef = useRef(explorer);
  explorerRef.current = explorer;
  const recordedSteps = useRef(new Set<number>());
  const explorerSteps = explorer?.steps;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the steps decide; history and texts follow
  useEffect(() => {
    if (explorerSteps === undefined) return;
    const ids = new Set(explorerSteps.map((step) => step.id));
    const now = history.now();
    history.drop((step) => {
      const id = step.tag?.startsWith("explorer:") === true ? Number(step.tag.slice(9)) : null;
      return id !== null && !ids.has(id) && now.steps.indexOf(step) < now.done;
    });
    for (const step of explorerSteps) {
      if (recordedSteps.current.has(step.id)) continue;
      recordedSteps.current.add(step.id);
      history.record(
        t("graphCanvas.step.explorer", {
          name: step.caption,
          count: countText(t, language, "node", step.loaded),
        }),
        () => explorerRef.current?.remove(step.id),
        () => explorerRef.current?.putBack(step),
        `explorer:${step.id}`,
      );
    }
  }, [explorerSteps]);

  // The search: its hits, and the node it jumps to once the view draws it (a group opened, a
  // hidden node shown).
  const searchQuery = search?.query ?? "";
  const searchScope = search?.scope ?? DEFAULT_SCOPE;
  // Typing stays quick in large graphs: the hits follow the field when there is time.
  const deferredQuery = useDeferredValue(searchQuery);
  const hits = useMemo(
    () => (deferredQuery === "" ? [] : searchGraph(model, deferredQuery, searchScope)),
    [model, deferredQuery, searchScope],
  );
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  useEffect(() => {
    if (jumpTarget === null) return;
    const index = nodeIndexOf(model, view, jumpTarget);
    if (index === null || visibility.nodes[index] !== 1) return;
    setJumpTarget(null);
    const key = view.nodes[index]?.key;
    if (key === undefined) return;
    setSelection([key]);
    setEdgeSelection([]);
    setSheetEdge(null);
    setCursor(key);
    canvasRef.current?.focus(index);
  }, [jumpTarget, model, view, visibility]);

  // The info card shows once the pointer rested on a node or an edge; it goes at once.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );
  function hovered(target: CanvasTarget | null) {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (target === null) {
      setCard(null);
      return;
    }
    hoverTimer.current = setTimeout(() => setCard(target), CARD_DELAY_MS);
  }

  // The minimap starts folded in small panels (frame 6); M and its button switch it.
  const narrow = stageSize.width > 0 && stageSize.width < NARROW_CANVAS_PX;
  const minimapOpen =
    minimap ??
    !(
      stageSize.width > 0 &&
      (stageSize.width < MINIMAP_MIN_WIDTH || stageSize.height < MINIMAP_MIN_HEIGHT)
    );
  const toolsSize = useBoxSize();
  // No node is placed under the canvas tools (top left) or the open minimap (bottom right).
  const keepOut = useMemo<KeepOut[]>(
    () => [
      { corner: "topLeft", width: toolsSize.width, height: toolsSize.height },
      ...(minimapOpen
        ? [{ corner: "bottomRight" as const, width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }]
        : []),
    ],
    [toolsSize.width, toolsSize.height, minimapOpen],
  );
  // The pinned nodes as the layouts read them (pinned.ts): a change of layout releases them.
  const releaseRef = useRef(releaseAll);
  releaseRef.current = releaseAll;
  const pinnedNodes = useMemo(
    () => pinnedForLayouts(viewEdits.places, () => releaseRef.current()),
    [viewEdits.places],
  );

  const notices: ReactNode[] = [];
  if (model.cut) {
    notices.push(
      t("graph.notice.cut", {
        shown: number.format(model.nodes.length),
        count: number.format(model.total.nodes),
      }),
    );
  }
  for (const notice of model.notices) {
    notices.push(noticeText(t, notice) || t("graph.notice.truncated"));
  }
  if (model.truncated && model.notices.length === 0) notices.push(t("graph.notice.truncated"));
  if (model.dangling > 0)
    notices.push(t("graph.notice.dangling", { count: number.format(model.dangling) }));

  const drawn = display === "graph" && DRAWABLE && !hierarchyTooLarge;
  const legend = useMemo(
    () =>
      labelCounts(model).map(({ label, index, count }) => ({
        label,
        count,
        group: graph.labelGroup(index),
        shape: graph.labelShape(index),
      })),
    [model, graph.labelGroup, graph.labelShape],
  );

  // Nodes the steps added beyond the query's own result.
  const baseCount = useMemo(() => nodeIds(graphs.map((g) => g.graph)).size, [graphs]);
  const fromSteps = Math.max(0, model.nodes.length - baseCount);

  // Pins in the order they were pinned, with the step that brought each.
  const pinEntries: PinEntry[] = pins.map((id) => {
    const at = model.index.get(id);
    const index = at === undefined ? -1 : (view.nodeOf[at] ?? -1);
    const stepAt = steps.findIndex((s) => s.graph.nodes.some((n) => n.id === id));
    const inBase = graphs.some((g) => g.graph.nodes.some((n) => n.id === id));
    return {
      id,
      caption: (at === undefined ? undefined : model.nodes[at]?.caption) ?? id,
      step: inBase || stepAt < 0 ? 0 : stepAt + 1,
      index: index >= 0 && view.nodes[index]?.node === at ? index : null,
    };
  });

  const primaryModel = primary === null ? null : modelIndex(primary);
  const primaryData = primaryModel === null ? undefined : model.nodes[primaryModel];
  const primaryStep = primaryData === undefined ? undefined : lastStepOf(primaryData.id);
  const primaryLinks =
    primaryData === undefined
      ? []
      : linksForRecord(
          options.dataLinks,
          (field) => graphValue(primaryData.properties, field, primaryData.id),
          linkValues,
        );
  const edgeLinksOf = (edge: number) => {
    const data = model.edges[edge];
    return data === undefined
      ? []
      : linksForRecord(
          options.dataLinks,
          (field) => graphValue(data.properties, field),
          linkValues,
        );
  };
  const expandText =
    !explorerOn || primaryData === undefined
      ? null
      : explorer.pending?.nodeId === primaryData.id
        ? t("graph.explorer.loading")
        : primaryStep === undefined
          ? t("graph.explorer.expand")
          : hasMore(primaryStep)
            ? t("graph.explorer.more", { count: number.format(primaryStep.settings.limit) })
            : null;
  const moreText =
    primaryStep === undefined || primaryStep.total === null
      ? null
      : t("graph.explorer.loadedOf", {
          name: primaryStep.caption,
          total: number.format(primaryStep.total),
          count: number.format(primaryStep.skipped + primaryStep.loaded),
        });

  // The exploration as a Cypher query, for Explore.
  const shownIds =
    explorerOn && host.openInExplore !== undefined
      ? view.nodes.flatMap((node, i) =>
          node.node >= 0 && visibility.nodes[i] === 1 ? [model.nodes[node.node]?.id ?? ""] : [],
        )
      : [];
  const queryNote =
    shownIds.length > MAX_QUERY_NODES
      ? t("graph.steps.tooManyForQuery", { max: number.format(MAX_QUERY_NODES) })
      : null;
  const openQuery = (() => {
    if (!explorerOn || host.openInExplore === undefined) return null;
    const ids = shownIds;
    if (ids.length > MAX_QUERY_NODES) return null;
    const cypher = explorationQuery(explorer.kind, ids);
    if (cypher === null) return null;
    const openInExplore = host.openInExplore;
    return () => openInExplore(explorer.datasourceId, { cypher });
  })();

  const explorerNote =
    explorer === null
      ? null
      : explorer.unavailable === "kind"
        ? t(
            explorer.kind === "tigergraph"
              ? "graph.explorer.noTigerGraph"
              : "graph.explorer.noKind",
          )
        : explorer.unavailable === "right"
          ? t("graph.explorer.noRight")
          : null;
  const showSheet =
    (sheetOpen && primary !== null) || selectedList.length > 1 || pinEntries.length > 0;

  // The board offers top to bottom and left to right; a panel set to another direction keeps it.
  const directionChoices = TOOLBAR_DIRECTIONS.includes(options.elkDirection)
    ? TOOLBAR_DIRECTIONS
    : [...TOOLBAR_DIRECTIONS, options.elkDirection];
  // Kalzit's layers point down; another direction lays the hierarchy out with ELK.
  const elk = hierarchyElk(options, direction);
  const primaryCaption = primary === null ? null : (view.nodes[primary]?.caption ?? null);
  const sizeNote =
    options.sizeBy === ""
      ? null
      : options.sizeBy === "degree"
        ? t("graph.legend.sizeByDegree")
        : t("graph.legend.sizeBy", { name: options.sizeBy });

  /** The table view takes the history's keys too, and A goes back to the drawing. */
  function onTableKey(event: KeyboardEvent<HTMLElement>) {
    if (isComposingKey(event)) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && key === "z") {
      if (event.shiftKey ? redo() : undo()) event.preventDefault();
    } else if (!mod && !event.altKey && event.shiftKey && key === "h") {
      event.preventDefault();
      showItems();
    } else if (!mod && !event.altKey && !event.shiftKey && key === "a" && DRAWABLE) {
      event.preventDefault();
      setDisplay("graph");
    }
  }

  const pinnedText =
    editOptions === undefined
      ? t("graphCanvas.summary.pinned", { count: number.format(pins.length) })
      : t("graphCanvas.summary.pinnedPanel", { count: number.format(pins.length) });

  /** Copies an element's properties as JSON, for "Copy properties". */
  function copyProperties(properties: Record<string, unknown>) {
    const text = JSON.stringify(properties, null, 2);
    void navigator.clipboard?.writeText(text).then(
      () => setAnnouncement(t("graphCanvas.announce.copied")),
      () => setAnnouncement(t("graphCanvas.announce.notCopied")),
    );
  }

  /**
   * The entries of a context menu (Graph 0.8.1 board, frame 3). An entry the person may not use
   * is left out; one that can do nothing right now stays, greyed, with the reason.
   */
  function menuOf(open: CanvasMenu): { title: string; entries: CanvasMenuEntry[] } {
    const query = explorerOn;
    const nothingPinned = pins.length === 0 ? t("graphCanvas.menu.nothingPinned") : undefined;
    if (open.kind === "edge") {
      const edge = view.edges[open.index];
      const data = edge !== undefined && edge.edge >= 0 ? model.edges[edge.edge] : undefined;
      const type = data?.type ?? "";
      return {
        title: describeEdge(open.index),
        entries: [
          {
            key: "ends",
            label: t("graphCanvas.edge.selectEnds"),
            onSelect: () => edge !== undefined && selectMany([edge.source, edge.target]),
          },
          ...(data === undefined
            ? []
            : [
                {
                  key: "type",
                  label: t("graphCanvas.menu.edgesOfType", { type }),
                  onSelect: () => {
                    const all = edgesOfType(view, visibility, type);
                    setSelection([]);
                    setEdgeSelection(all.flatMap((i) => view.edges[i]?.key ?? []));
                    setSheetEdge(edge?.key ?? null);
                    setAnnouncement(
                      t("graphCanvas.announce.edgesSelected", {
                        edges: countText(t, language, "edge", all.length),
                      }),
                    );
                  },
                },
              ]),
          { kind: "separator", key: "s1" },
          {
            key: "hide",
            label: t("graphCanvas.hide"),
            icon: "eyeOff",
            shortcut: "H",
            onSelect: () => hideItems([], [open.index]),
          },
          ...(data === undefined
            ? []
            : [
                {
                  key: "hideType",
                  label: t("graphCanvas.menu.hideType", { type }),
                  onSelect: () => hideItems([], edgesOfType(view, visibility, type)),
                },
                { kind: "separator" as const, key: "s2" },
                {
                  key: "copy",
                  label: t("graphCanvas.menu.copy"),
                  icon: "copy" as const,
                  onSelect: () => copyProperties(data.properties),
                },
              ]),
        ],
      };
    }
    if (open.kind === "selection") {
      const allPinned = selectedList.every((i) => {
        const id = idOf(i);
        return id !== undefined && pins.includes(id);
      });
      return {
        title: selectionText(selected),
        entries: [
          {
            key: "invert",
            label: t("graphCanvas.selection.invert"),
            shortcut: t("graphCanvas.key.ctrlI"),
            onSelect: invertSelection,
          },
          {
            key: "neighbours",
            label: t("graphCanvas.menu.addNeighbours"),
            shortcut: "N",
            onSelect: addNeighbours,
          },
          { kind: "separator", key: "s1" },
          {
            key: "hide",
            label: t("graphCanvas.hide"),
            icon: "eyeOff",
            shortcut: "H",
            onSelect: hideSelection,
          },
          {
            key: "only",
            label: t("graphCanvas.selection.only"),
            shortcut: "S",
            checked: only,
            onSelect: toggleOnly,
          },
          {
            key: "pin",
            label: allPinned ? t("graph.pin.remove") : t("graph.pin.add"),
            shortcut: "P",
            onSelect: () => togglePins(selectedList),
          },
          ...(multi && variable !== null
            ? [
                {
                  key: "variable",
                  label: t("graphCanvas.menu.setValues", {
                    name: variable,
                    count: number.format(values.length),
                  }),
                  unavailable: values.length === 0 ? t("graphCanvas.menu.noValues") : undefined,
                  onSelect: setVariableValuesFromSelection,
                },
              ]
            : []),
        ],
      };
    }
    if (open.kind === "node") {
      const node = view.nodes[open.index];
      const m = modelIndex(open.index);
      const data = m === null ? undefined : model.nodes[m];
      const isPinned = data !== undefined && pins.includes(data.id);
      const title =
        node === undefined
          ? ""
          : data === undefined
            ? node.caption
            : t("graphCanvas.menu.nodeTitle", {
                name: node.caption,
                labels: data.labels.join(", ") || t("graph.cluster.unlabelled"),
              });
      const step = data === undefined ? undefined : lastStepOf(data.id);
      const openOne =
        data !== undefined && query && host.openInExplore !== undefined
          ? explorationQuery(explorer.kind, [data.id])
          : null;
      const entries: CanvasMenuEntry[] = [];
      if (data !== undefined && query) {
        entries.push({
          key: "expand",
          label: t("graphCanvas.menu.expand"),
          unavailable:
            explorer.pending !== null
              ? t("graph.explorer.loading")
              : step !== undefined && !hasMore(step)
                ? t("graphCanvas.menu.allLoaded")
                : undefined,
          onSelect: () => expand(open.index),
        });
      }
      if (node !== undefined && node.node < 0) {
        entries.push({
          key: "open",
          label: t("graphCanvas.menu.openGroup"),
          onSelect: () => openGroup(node.cluster, node.caption),
        });
      }
      entries.push(
        {
          key: "neighbours",
          label: t("graphCanvas.menu.selectNeighbours"),
          shortcut: "N",
          onSelect: () =>
            selectMany([open.index, ...neighboursOf(view, visibility, new Set([open.index]))]),
        },
        { kind: "separator", key: "s1" },
      );
      if (data !== undefined) {
        entries.push({
          key: "pin",
          label: isPinned ? t("graph.pin.remove") : t("graph.pin.add"),
          icon: "pin",
          shortcut: "P",
          onSelect: () => togglePins([open.index]),
        });
      }
      entries.push(
        {
          key: "hide",
          label: t("graphCanvas.hide"),
          icon: "eyeOff",
          shortcut: "H",
          onSelect: () => hideItems([open.index]),
        },
        {
          key: "onlyAround",
          label: t("graphCanvas.menu.onlyAround"),
          onSelect: () => onlyWithNeighbours(open.index),
        },
      );
      if (data !== undefined && variable !== null && !multi) {
        entries.push({
          key: "variable",
          label: t("graphCanvas.menu.setVariable", { name: variable }),
          onSelect: () => setVariableFrom(open.index),
        });
      }
      if (openOne !== null && host.openInExplore !== undefined) {
        const openInExplore = host.openInExplore;
        entries.push({
          key: "explore",
          label: t("graphCanvas.menu.openInExplore"),
          onSelect: () => openInExplore(explorer?.datasourceId ?? "", { cypher: openOne }),
        });
      }
      if (data !== undefined) {
        entries.push(
          { kind: "separator", key: "s2" },
          {
            key: "copy",
            label: t("graphCanvas.menu.copy"),
            icon: "copy",
            onSelect: () => copyProperties(data.properties),
          },
        );
      }
      return { title, entries };
    }
    const hiddenCount = hiddenEntries.length;
    const ownEdits =
      viewEdits.edits.pins.length +
      viewEdits.edits.hidden.length +
      viewEdits.edits.hiddenEdges.length +
      viewEdits.edits.released.length;
    return {
      title: t("graphCanvas.menu.canvas"),
      entries: [
        {
          key: "all",
          label: t("graphCanvas.menu.selectAll"),
          shortcut: t("graphCanvas.key.ctrlA"),
          onSelect: selectAll,
        },
        {
          key: "search",
          label: t("graphCanvas.search.open"),
          icon: "search",
          shortcut: "F",
          onSelect: openSearch,
        },
        { kind: "separator", key: "s1" },
        {
          key: "show",
          label: t("graphCanvas.menu.showHidden", { count: number.format(hiddenCount) }),
          icon: "eye",
          shortcut: t("graphCanvas.key.shiftH"),
          unavailable: hiddenCount === 0 ? t("graphCanvas.menu.nothingHidden") : undefined,
          onSelect: () => showItems(),
        },
        {
          key: "release",
          label: t("graphCanvas.menu.releaseAll"),
          unavailable: nothingPinned,
          // The layouts release the same way when the layout changes (pinned.ts).
          onSelect: () => (pinnedNodes.positions.size > 0 ? pinnedNodes.release?.() : releaseAll()),
        },
        {
          key: "showPins",
          label: t("graphCanvas.menu.showPinned"),
          checked: showPins,
          onSelect: () => setShowPins(!showPins),
        },
        ...(editOptions === undefined && ownEdits > 0
          ? [{ key: "back", label: t("graphCanvas.menu.backToPanel"), onSelect: backToPanel }]
          : []),
        { kind: "separator", key: "s2" },
        {
          key: "fit",
          label: t("graph.fit"),
          icon: "expand",
          shortcut: "0",
          onSelect: () => canvasRef.current?.reset(),
        },
      ],
    };
  }

  return (
    <div className="graph" ref={rootRef}>
      <GraphToolbar
        title={title}
        drawable={DRAWABLE}
        layout={mode === "force" || layout !== mode ? { value: layout, onChange: setLayout } : null}
        direction={
          layout === "hierarchy"
            ? { value: direction, choices: directionChoices, onChange: setDirection }
            : null
        }
        display={display}
        onDisplay={setDisplay}
        explorer={
          explorer === null
            ? null
            : {
                on: explorerOn,
                disabled: explorer.unavailable !== null,
                note: explorerNote,
                onToggle: () => setExploring(!exploring),
              }
        }
        onCloseGroups={open.size > 0 ? closeGroups : null}
      />
      <p className="graph__summary">
        {t("graph.summary", {
          nodes: countText(t, language, "node", model.nodes.length),
          edges: countText(t, language, "edge", model.edges.length),
          components: countText(t, language, "component", parts.sizes.length),
        })}{" "}
        {fromSteps > 0 && steps.length > 0
          ? `${t("graph.steps.summary", {
              nodes: countText(t, language, "node", fromSteps),
              steps: countText(t, language, "step", steps.length),
            })} `
          : ""}
        {found !== null && fromDatabase
          ? t("graph.communities.database", {
              communities: countText(t, language, "community", found.count),
            })
          : model.nodes.length > COMMUNITY_LIMIT
            ? t("graph.communities.tooLarge", { limit: number.format(COMMUNITY_LIMIT) })
            : found === null
              ? ""
              : t("graph.communities.count", {
                  communities: countText(t, language, "community", found.count),
                })}
        {pins.length > 0 ? ` ${pinnedText} ` : null}
        {selectedList.length === 0 && selectedEdges.size === 0 ? null : (
          <span className="graph__summary-hint">
            {" "}
            {sheetEdgeIndex !== null && selectedList.length === 0 && selectedEdges.size === 1
              ? t("graphCanvas.summary.edge", { edge: describeEdge(sheetEdgeIndex) })
              : selectedList.length === 1 && selectedEdges.size === 0 && primaryCaption !== null
                ? t("graph.summary.selection", { name: primaryCaption })
                : selectedList.length > 0
                  ? t("graphCanvas.summary.selection", {
                      what: selectionText(selected, selectedEdges.size),
                    })
                  : t("graphCanvas.announce.edgesSelected", {
                      edges: countText(t, language, "edge", selectedEdges.size),
                    })}{" "}
            <kbd className="kbd">Esc</kbd> {t("graph.summary.clears")}
          </span>
        )}
      </p>
      {hiddenEntries.length + hiddenResting > 0 ? (
        <p className="graph__summary">
          {t("graphCanvas.summary.hidden", {
            nodes: number.format(
              shownCounts(withoutHidden(view, unhidden, hidden.nodes, hidden.edges)).nodes,
            ),
            totalNodes: number.format(shownCounts(unhidden).nodes),
            edges: number.format(
              shownCounts(withoutHidden(view, unhidden, hidden.nodes, hidden.edges)).edges,
            ),
            totalEdges: number.format(shownCounts(unhidden).edges),
            count: number.format(hiddenEntries.length),
          })}
          {hiddenResting > 0
            ? ` ${t("graphCanvas.summary.resting", { count: number.format(hiddenResting) })}`
            : null}
        </p>
      ) : null}
      {only && selected.size > 0 ? (
        <p className="graph__summary">
          {t("graph.selection.onlySummary", {
            shown: number.format(selected.size),
            count: number.format(model.nodes.length),
            edges: countText(
              t,
              language,
              "edge",
              visibility.edges.reduce((sum, v) => sum + v, 0),
            ),
          })}{" "}
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setOnly(false)}
          >
            {t("graph.selection.showAll")}
          </button>
        </p>
      ) : null}
      {notices.length > 0 || view.clustered || !DRAWABLE ? (
        <ul className="graph__notices">
          {!DRAWABLE ? <li>{t("graph.notice.noWebgl")}</li> : null}
          {notices.map((notice, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: notices keep their order
            <li key={i}>{notice}</li>
          ))}
          {view.clustered ? (
            <li>
              {t("graph.notice.clustered", {
                nodes: number.format(AUTO_CLUSTER_NODES),
                edges: number.format(AUTO_CLUSTER_EDGES),
              })}{" "}
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setUnclustered(true)}
              >
                {t("graph.cluster.showAll")}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {explorerNote !== null && options.explorer ? (
        <p className="graph__note">{explorerNote}</p>
      ) : null}
      {explorer?.error ? (
        <p className="graph__note graph__note--error" role="alert">
          {explorer.error}
        </p>
      ) : null}
      {explorerOn ? (
        <ExplorerBar
          explorer={explorer}
          baseNodes={baseCount}
          edgeTypes={model.edgeTypes}
          onBack={(removed) =>
            setAnnouncement(t("graph.announce.stepsUndone", { count: number.format(removed) }))
          }
          onOpenQuery={openQuery}
          queryNote={queryNote}
          compact={short}
        />
      ) : null}
      {graph.steps.length > 1 ? (
        <TimeSlider steps={graph.steps} index={timeIndex} onChange={setTimeIndex} />
      ) : null}
      <div className="graph__body">
        {hierarchyTooLarge && display === "graph" && DRAWABLE ? (
          <GraphState
            icon="alert"
            actions={
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => setLayout("force")}
              >
                {t("graph.hierarchy.asNetwork")}
              </button>
            }
          >
            {t("graph.hierarchy.tooLarge", {
              limit: number.format(HIERARCHY_LIMIT),
              count: number.format(model.nodes.length),
            })}
          </GraphState>
        ) : drawn ? (
          <div className="graph-canvas" ref={stageSize.measure}>
            <div
              className="graph__stage"
              ref={stageRef}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the drawing takes arrow keys to move the selection
              tabIndex={0}
              role="application"
              aria-roledescription={t("graph.roleDescription")}
              aria-label={title}
              aria-describedby={hintId}
              aria-busy={(explorer?.pending ?? null) !== null}
              onKeyDown={onStageKey}
            >
              <Probes />
              {palette === null ? null : (
                <Suspense fallback={<p className="panel-empty">{t("common.loading")}</p>}>
                  <DrawnGraph
                    ref={canvasRef}
                    onReady={setCanvasReady}
                    view={view}
                    mode={layout}
                    elk={elk}
                    palette={palette}
                    visibility={visibility}
                    ranks={ranks}
                    selected={selected}
                    primary={primary}
                    neighbours={neighbours}
                    selectedEdges={selectedEdges}
                    fixed={fixed}
                    keepOut={keepOut}
                    tool={tool.name}
                    draggable
                    drawStyle={style}
                    onPick={(index, additive) => {
                      setEdgeWalk(null);
                      pick(index, additive);
                    }}
                    onPickEdge={pickEdge}
                    onMove={moved}
                    onHover={hovered}
                    onMenu={openMenu}
                    onArea={selectArea}
                    onGestureHint={setGestureHint}
                    camera={camera}
                  />
                </Suspense>
              )}
              {gestureHint === null ? null : (
                <p className="graph__gesture" aria-hidden="true">
                  {gestureHint === "wheel" ? t("graph.gesture.wheel") : t("graph.gesture.touch")}
                </p>
              )}
            </div>
            {visibility.nodes.length > 0 &&
            hiddenHere.nodes.length > 0 &&
            shownCounts(visibility).nodes === 0 ? (
              <div className="graph-canvas__state">
                <GraphState
                  icon="eyeOff"
                  actions={
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => showItems()}
                    >
                      {t("graphCanvas.hidden.showAll")}
                    </button>
                  }
                >
                  {t("graphCanvas.hidden.allHidden", {
                    count: number.format(shownCounts(unhidden).nodes),
                  })}
                </GraphState>
              </div>
            ) : null}
            <div className="graph-canvas__tools" ref={toolsSize.measure}>
              <ToolStrip
                title={title}
                tool={tool.name}
                locked={tool.locked}
                onTool={chooseTool}
                searching={search !== null}
                onSearch={() => (search === null ? openSearch() : setSearch(null))}
                history={history.history}
                onUndo={() => undo()}
                onRedo={() => redo()}
                onGoTo={(done) => {
                  history.goTo(done);
                  setAnnouncement(t("graphCanvas.announce.restored"));
                }}
                onZoom={(factor) => canvasRef.current?.zoom(factor)}
                onFit={() => canvasRef.current?.reset()}
                narrow={narrow}
                disabled={palette === null}
              />
              {search === null ? null : (
                <SearchBox
                  query={search.query}
                  onQuery={(query) => setSearch({ ...search, query, current: -1 })}
                  scope={search.scope}
                  onScope={(scope) => setSearch({ ...search, scope, current: -1 })}
                  hits={hits}
                  current={search.current}
                  onJump={jumpTo}
                  onClose={() => {
                    setSearch(null);
                    stageRef.current?.focus();
                  }}
                  noteOf={noteOf}
                  nodes={model.nodes.length}
                />
              )}
            </div>
            <div className="graph-canvas__bottom">
              <HiddenList
                entries={hiddenEntries}
                onShow={(id) => showItems([id])}
                onShowAll={() => showItems()}
              />
              {selectedList.length >= 2 ? (
                <SelectionBar
                  text={selectionText(selected, selectedEdges.size)}
                  only={only}
                  onInvert={invertSelection}
                  onHide={hideSelection}
                  onOnly={toggleOnly}
                />
              ) : null}
              <Minimap
                canvas={canvasRef}
                ready={canvasReady}
                open={minimapOpen}
                onToggle={() => setMinimap(!minimapOpen)}
              />
            </div>
            {showPins ? (
              <PinMarks
                canvas={canvasRef}
                ready={canvasReady}
                stage={stageRef}
                nodes={pinMarkNodes}
              />
            ) : null}
            {card === null || menu !== null ? null : (
              <InfoCard
                target={card}
                model={model}
                view={view}
                chosen={options.infoCard}
                captionProperty={options.caption}
              />
            )}
          </div>
        ) : (
          <GraphTable
            model={model}
            view={view}
            visibility={visibility}
            selected={selected}
            onSelect={pick}
            title={title}
            pinned={pins}
            onTogglePin={togglePin}
            selectedEdges={selectedEdges}
            onSelectEdge={pickEdge}
            hidden={hiddenEntries}
            onShow={(id) => showItems(id === undefined ? undefined : [id])}
            onKeyDown={onTableKey}
            onSelectMany={selectMany}
            onRowMenu={(row, at) => openMenu({ ...row, x: at.x, y: at.y, reach: 0 }, at)}
          />
        )}
        {sheetEdgeIndex !== null && sheetOpen && selectedEdges.has(sheetEdgeIndex) ? (
          <EdgeSheet
            model={model}
            view={view}
            edge={sheetEdgeIndex}
            links={edgeLinksOf(view.edges[sheetEdgeIndex]?.edge ?? -1)}
            actions={{
              selectNode: (index) => select(index),
              selectEnds: (edge) => {
                const drawnEdge = view.edges[edge];
                if (drawnEdge !== undefined) selectMany([drawnEdge.source, drawnEdge.target]);
              },
              selectEdge: (edge) => pickEdge(edge),
              hide: (edge) => hideItems([], [edge]),
            }}
          />
        ) : showSheet ? (
          <NodeSheet
            model={model}
            view={view}
            parts={parts}
            found={found}
            selected={selectedList}
            primary={sheetOpen ? primary : null}
            pinned={new Set(pins)}
            pins={pinEntries}
            only={only}
            variable={variable}
            values={values}
            capped={capped}
            expandText={expandText}
            moreText={moreText}
            links={primaryLinks}
            edgeLinksOf={edgeLinksOf}
            actions={{
              select: (index) => select(index),
              deselect: (index) => select(index, true),
              clear: clearSelection,
              togglePin,
              open: activate,
              expand: explorerOn && explorer.pending === null ? expand : null,
              setVariable: variable === null || multi ? null : setVariableFrom,
              setValues: multi && values.length > 0 ? setVariableValuesFromSelection : null,
              toggleOnly,
            }}
          />
        ) : null}
      </div>
      {menu === null ? null : (
        <ContextMenu
          {...menuOf(menu)}
          at={menu.at}
          host={rootRef.current?.closest("main") ?? null}
          onClose={(refocus) => {
            setMenu(null);
            // Back to where the menu was opened from: the canvas, or a row of the table.
            const back = menuReturn.current;
            menuReturn.current = null;
            if (refocus) (back?.isConnected === true ? back : stageRef.current)?.focus();
          }}
        />
      )}
      {legend.length > 1 || graph.property !== null || sizeNote !== null ? (
        <Legend
          sizeNote={sizeNote}
          labels={legend}
          hidden={hiddenLabels}
          onToggle={(label) => {
            const next = new Set(hiddenLabels);
            if (next.has(label)) next.delete(label);
            else next.add(label);
            setHiddenLabels(next);
          }}
          swatches={options.colorBy === "label"}
          property={graph.property as PropertyPaint | null}
          ramp={style.ramp}
          propertyName={options.colorProperty}
        />
      ) : null}
      <p className="visually-hidden" id={hintId}>
        {t("graph.keyboardHint")}
      </p>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}

/**
 * The previous list while its items are the same objects: the page around the panel may build
 * the list anew on every render, and the graph should only be rebuilt when a result changed.
 */
function useSameList<T>(list: readonly T[]): readonly T[] {
  const ref = useRef(list);
  const previous = ref.current;
  const same = previous.length === list.length && previous.every((item, i) => item === list[i]);
  useEffect(() => {
    if (!same) ref.current = list;
  });
  return same ? previous : list;
}

/** Hidden elements carrying the theme colors the renderer reads (colors.ts). */
function Probes() {
  const names = [
    ...Array.from({ length: GRAPH_COLORS }, (_, i) => `${i + 1}`),
    ...["blues", "gyr", "grays"].flatMap((ramp) =>
      Array.from({ length: 5 }, (_, i) => `${ramp}-${i + 1}`),
    ),
    "neutral",
    "edge",
    "text",
    "bg",
    "active",
  ];
  return (
    <div className="graph__probes" aria-hidden="true">
      {names.map((name) => (
        <span key={name} className={`graph__probe graph__probe--${name}`} />
      ))}
    </div>
  );
}

interface DrawnGraphProps {
  view: GraphView;
  mode: LayoutMode;
  /** ELK's settings when the panel's hierarchy uses ELK; null for Kalzit's own layout. */
  elk: ElkSettings | null;
  palette: GraphPalette;
  visibility: Visibility;
  ranks: Int32Array;
  selected: ReadonlySet<number>;
  primary: number | null;
  neighbours: ReadonlySet<number>;
  selectedEdges: ReadonlySet<number>;
  fixed: ReadonlyMap<number, readonly [number, number]>;
  keepOut: readonly KeepOut[];
  tool: CanvasTool;
  draggable: boolean;
  drawStyle: DrawStyle;
  onPick: (node: number | null, additive: boolean) => void;
  onPickEdge: (edge: number, additive: boolean) => void;
  onMove: (moves: readonly NodeMove[]) => void;
  onHover: (target: CanvasTarget | null) => void;
  onMenu: (target: CanvasTarget | null, at: { x: number; y: number }) => void;
  onArea: (nodes: readonly number[], mode: AreaMode) => void;
  onGestureHint: (gesture: "wheel" | "touch") => void;
  onReady: (ready: boolean) => void;
  camera: { current: CameraState | null };
  ref: Ref<CanvasHandle>;
}

/** The drawing with its layout. With reduced motion, nodes jump to where the layout settles. */
function DrawnGraph({ view, mode, elk, ref, drawStyle, ...rest }: DrawnGraphProps) {
  const layout = useGraphLayout(view, mode, elk);
  const reduced = prefersReducedMotion();
  const [shown, setShown] = useState<Float32Array | null>(null);
  const positions = layout.positions;
  // The layout settles visibly for small graphs. With reduced motion, and for large graphs (where
  // each redraw of every node is a noticeable pause), only the start and the end are drawn.
  const progressive = !reduced && view.nodes.length <= PROGRESSIVE_NODES;
  useEffect(() => {
    if (positions !== null && (progressive || !layout.running)) {
      setShown(positions);
    } else if (positions !== null) {
      setShown((current) => current ?? positions);
    }
  }, [positions, layout.running, progressive]);
  if (shown === null || shown.length !== view.nodes.length * 2) {
    return null;
  }
  return (
    <>
      <LazySigmaCanvas
        ref={ref}
        view={view}
        positions={shown}
        reducedMotion={reduced}
        drawStyle={drawStyle}
        spread={mode === "force"}
        settling={layout.running}
        {...rest}
      />
      <LayoutNotes
        layout={layout}
        hierarchy={mode === "hierarchy"}
        settling={layout.running && !progressive}
      />
    </>
  );
}

/** Graphs above this many nodes are drawn when their layout has settled, not while it moves. */
export const PROGRESSIVE_NODES = 2_000;

/**
 * Notes over the drawing, one under the other: the layout still at work (ELK loading and
 * running, or a large graph settling), why ELK's layout is not shown, and edges closing a cycle.
 */
function LayoutNotes({
  layout,
  hierarchy,
  settling,
}: {
  layout: LayoutState;
  hierarchy: boolean;
  settling: boolean;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const lines: string[] = [];
  if (layout.engine === "elk" && layout.running) {
    lines.push(t("graph.layout.elkRunning"));
  } else if (settling) {
    lines.push(t("graph.layout.settling"));
  }
  if (layout.notice === "elkFailed") lines.push(t("graph.layout.elkFailed"));
  if (layout.notice === "elkTooLarge") {
    lines.push(t("graph.layout.elkTooLarge", { limit: number.format(MAIN_THREAD_ELK_LIMIT) }));
  }
  if (hierarchy && layout.reversed > 0) {
    lines.push(t("graph.notice.cycles", { count: number.format(layout.reversed) }));
  }
  if (lines.length === 0) return null;
  return (
    <div className="graph__overlay-note" role="status">
      {lines.map((line) => (
        <p key={line} className="graph__overlay-line">
          {line}
        </p>
      ))}
    </div>
  );
}

/** How long the slider rests before the graph follows it; dragging redraws once, not per step. */
export const SLIDER_DEBOUNCE_MS = 150;

/** The graph at a point in time: edges with a later timestamp are hidden. */
function TimeSlider({
  steps,
  index,
  onChange,
}: {
  steps: readonly number[];
  index: number | null;
  onChange: (index: number | null) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const last = steps.length - 1;
  // The slider and its text follow at once; the graph after SLIDER_DEBOUNCE_MS.
  const [moving, setMoving] = useState<number | null>(null);
  useEffect(() => {
    if (moving === null) return;
    const timer = setTimeout(() => {
      onChange(moving >= last ? null : moving);
      setMoving(null);
    }, SLIDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [moving, last, onChange]);
  const at = moving ?? index ?? last;
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  const text = format.format(steps[at] ?? 0);
  return (
    <div className="graph__time">
      <label className="graph__time-label" htmlFor={id}>
        {t("graph.time.label")}
      </label>
      <input
        id={id}
        className="graph__time-range"
        type="range"
        min={0}
        max={last}
        step={1}
        value={at}
        aria-valuetext={text}
        onChange={(event) => setMoving(Number(event.currentTarget.value))}
      />
      <output className="graph__time-value" htmlFor={id}>
        {text}
      </output>
    </div>
  );
}
