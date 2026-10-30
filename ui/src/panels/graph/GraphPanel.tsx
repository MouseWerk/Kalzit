import {
  type KeyboardEvent,
  lazy,
  type ReactNode,
  type Ref,
  Suspense,
  useEffect,
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
import { isMultiVariable, setVariableFromClick, setVariableValues, usePanelHost } from "../host";
import { EmptyPanel } from "../shared";
import type { PanelGraph, PanelProps } from "../types";
import { explorationQuery, MAX_QUERY_NODES, propertyText } from "./adapter";
import { type GraphPalette, prefersReducedMotion, readPalette, useThemeVersion } from "./colors";
import type { Direction, DrawStyle } from "./drawing";
import { ExplorerBar } from "./ExplorerBar";
import { MAIN_THREAD_ELK_LIMIT } from "./elkLayout";
import { GraphTable } from "./GraphTable";
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
import { COMMUNITY_LIMIT, type Communities, communities, components } from "./metrics";
import { buildGraphModel, edgeTimes, edgeWidths, GRAPH_COLORS, nodeSizes } from "./model";
import { NodeSheet, type PinEntry } from "./NodeSheet";
import {
  AUTO_CLUSTER_EDGES,
  AUTO_CLUSTER_NODES,
  type ElkSettings,
  elkSettings,
  type GraphPanelOptions,
} from "./options";
import { labelGroupOf, type PropertyPaint, propertyPaint } from "./paint";
import { countText } from "./plural";
import type { CanvasHandle } from "./SigmaCanvas";
import { useShortPanel } from "./shortPanel";
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
import { usePanelViewState } from "./viewState";
import "./graph.css";

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
  const host = usePanelHost();
  const graphs = props.graphs ?? [];
  if (graphs.length === 0) {
    return <EmptyPanel reason="noData" />;
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
  const { labelColors, colorBy, colorProperty, colorScheme, colorRange, colorMin, colorMax } =
    options;
  const labelGroup = useMemo(() => labelGroupOf(model, labelColors), [model, labelColors]);
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
      }),
    [model, sizes, widths, groups, cluster, open, clusterText, unlabelled, labelGroup],
  );
  const times = useMemo(
    () => edgeTimes(model, options.timeProperty),
    [model, options.timeProperty],
  );
  const steps = useMemo(() => timeSteps(times), [times]);
  const ranks = useMemo(() => labelRanks(view), [view]);
  return { model, parts, view, times, steps, ranks, property, labelGroup };
}

function GraphPanelBody({ graphs, options, title, mode, explorer }: BodyProps) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  // The camera outlives the canvas: a view with other nodes (a loaded neighbourhood, an opened
  // group) draws in a new one, and the zoom and centre stay where the user left them.
  const camera = useRef<CameraState | null>(null);
  const number = new Intl.NumberFormat(language);
  const [display, setDisplay] = useState<"graph" | "table">(DRAWABLE ? "graph" : "table");
  const [layout, setLayout] = useState<LayoutMode>(mode);
  // The explorer is the viewer's: on as the panel says, switched for this view only.
  const [exploring, setExploring] = useState(options.explorer);
  // Selected view keys in the order they were selected; the cursor is the node the keyboard
  // moves from and the details are of.
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [only, setOnly] = useState(false);
  const [hiddenLabels, setHiddenLabels] = useState<ReadonlySet<string>>(new Set());
  // Pinned node ids, and each pinned node as it was when pinned (kept while its step is gone).
  const [pins, setPins] = useState<readonly string[]>([]);
  const [pinned, setPinned] = useState<ReadonlyMap<string, PinnedNode>>(NO_PINS);
  // Whether the focus is inside the panel; Escape clears the selection only then.
  const rootRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const short = useShortPanel(rootRef);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onIn = () => setFocused(true);
    const onOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))) {
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

  // Communities only for graphs small enough to compute them without a noticeable pause.
  useEffect(() => {
    let current = true;
    setFound(null);
    if (model.nodes.length <= COMMUNITY_LIMIT) {
      void communities(model).then((result) => {
        if (current) setFound(result);
      });
    }
    return () => {
      current = false;
    };
  }, [model]);

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

  const timeAt = timeIndex === null ? null : (graph.steps[timeIndex] ?? null);
  const visibility = useMemo(() => {
    const atTime = timeAt === null ? allVisible(view) : visibleAt(model, view, times, timeAt);
    const shown = withoutLabels(model, view, atTime, hiddenLabels);
    return only && selected.size > 0 ? onlySelection(view, shown, selected) : shown;
  }, [model, view, times, timeAt, hiddenLabels, only, selected]);

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
  // hold back the shell's shortcuts: Ctrl+K, ?, / and F6 still work after clicking a node.
  useEscapeLayer(focused && selected.size > 0, () => clearSelection(), { blocking: false });

  // The viewer's own pins and selection of this dashboard panel, kept on the server.
  const kept = usePanelViewState(host.orgId, host.view);
  const [restoredState, setRestoredState] = useState(false);
  useEffect(() => {
    // Pins that need fetching wait until the panel knows whether the source may be queried.
    if (restoredState || !kept.settled || explorer?.unavailable === "loading") return;
    setRestoredState(true);
    const state = kept.state;
    if (state === null) return;
    setPins(state.pinned);
    setSelection(state.selected.map((id) => `n:${id}`));
    const missing = state.pinned.filter((id) => !model.index.has(id));
    if (missing.length > 0 && explorer !== null) explorer.restore(missing);
  }, [restoredState, kept.settled, kept.state, model, explorer]);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `kept.keep` sends; the state decides when
  useEffect(() => {
    if (restoredState) kept.keep({ pinned: [...pins], selected: keptSelection });
  }, [restoredState, pins, keptSelection]);

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
      setOpen((current) => new Set([...current, node.cluster]));
      setAnnouncement(t("graph.announce.opened", { name: node.caption }));
      return;
    }
    if (options.clickAction === "variable") setVariableFrom(index);
    if (options.clickAction === "expand") expand(index);
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

  function togglePin(id: string) {
    const has = pins.includes(id);
    setPins(has ? pins.filter((p) => p !== id) : [...pins, id]);
    const at = model.index.get(id);
    if (!has && at !== undefined) {
      const pin = pinOf(model, at);
      if (pin !== null) setPinned((current) => new Map(current).set(id, pin));
    }
    const caption = (at === undefined ? undefined : model.nodes[at]?.caption) ?? id;
    setAnnouncement(
      has
        ? t("graph.announce.unpinned", { name: caption })
        : t("graph.announce.pinned", { name: caption }),
    );
  }

  function toggleOnly() {
    if (selected.size === 0 && !only) return;
    setOnly(!only);
  }

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    if (isComposingKey(event)) return;
    const directions: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directions[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      const next = canvasRef.current?.nodeToward(primary, direction) ?? null;
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
    const cursorAt = cursorIndex ?? primary;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
      if (explorerOn && (explorer.steps.length > 0 || explorer.pending !== null)) {
        event.preventDefault();
        const name = explorer.pending?.caption ?? explorer.steps.at(-1)?.caption ?? "";
        explorer.undo();
        setAnnouncement(t("graph.announce.undone", { name }));
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter" && cursorAt !== null) {
      event.preventDefault();
      const node = view.nodes[cursorAt];
      if (node !== undefined && node.node >= 0 && explorerOn) expand(cursorAt);
      else activate(cursorAt);
    } else if (event.key === " " && cursorAt !== null) {
      event.preventDefault();
      select(cursorAt, true);
    } else if (key === "p" && cursorAt !== null) {
      const m = modelIndex(cursorAt);
      const id = m === null ? undefined : model.nodes[m]?.id;
      if (id !== undefined) {
        event.preventDefault();
        togglePin(id);
      }
    } else if (key === "s") {
      event.preventDefault();
      toggleOnly();
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      canvasRef.current?.zoom(1.5);
    } else if (event.key === "-") {
      event.preventDefault();
      canvasRef.current?.zoom(1 / 1.5);
    } else if (event.key === "0") {
      event.preventDefault();
      canvasRef.current?.reset();
    }
  }

  // Announces what a finished step loaded, once per step.
  const announcedStep = useRef<number | null>(null);
  const newest = explorer?.steps.at(-1);
  useEffect(() => {
    if (newest === undefined || announcedStep.current === newest.id) return;
    announcedStep.current = newest.id;
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
      })),
    [model, graph.labelGroup],
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

  return (
    <div className="graph" ref={rootRef}>
      {/* A group, not role="toolbar" (which promises one Tab stop with arrow keys inside): each
          button is its own Tab stop, as in the rest of the panel. */}
      {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a field set */}
      <div className="graph__toolbar" role="group" aria-label={t("graph.toolbar", { title })}>
        {drawn ? (
          <>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => canvasRef.current?.zoom(1.5)}
            >
              {t("graph.zoomIn")}
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => canvasRef.current?.zoom(1 / 1.5)}
            >
              {t("graph.zoomOut")}
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => canvasRef.current?.reset()}
            >
              {t("graph.fit")}
            </button>
          </>
        ) : null}
        {DRAWABLE ? (
          <>
            <LayoutChoice value={layout} onChange={setLayout} />
            <button
              type="button"
              className="button button--ghost button--small"
              aria-pressed={display === "table"}
              onClick={() => setDisplay(display === "graph" ? "table" : "graph")}
            >
              {t("graph.showTable")}
            </button>
          </>
        ) : null}
        {explorer === null ? null : (
          <button
            type="button"
            className="button button--ghost button--small"
            aria-pressed={explorerOn}
            disabled={explorer.unavailable !== null}
            title={explorerNote ?? undefined}
            onClick={() => setExploring(!exploring)}
          >
            {t("graph.explorer.toggle")}
          </button>
        )}
        {open.size > 0 ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setOpen(new Set())}
          >
            {t("graph.cluster.closeAll")}
          </button>
        ) : null}
      </div>
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
        {model.nodes.length > COMMUNITY_LIMIT
          ? t("graph.communities.tooLarge", { limit: number.format(COMMUNITY_LIMIT) })
          : found === null
            ? ""
            : t("graph.communities.count", {
                communities: countText(t, language, "community", found.count),
              })}
      </p>
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
          <div className="graph__state" role="status">
            <p>
              {t("graph.hierarchy.tooLarge", {
                limit: number.format(HIERARCHY_LIMIT),
                count: number.format(model.nodes.length),
              })}
            </p>
            <div className="graph__actions">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => setLayout("force")}
              >
                {t("graph.hierarchy.asNetwork")}
              </button>
            </div>
          </div>
        ) : drawn ? (
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
                  view={view}
                  mode={layout}
                  elk={elkSettings(options)}
                  palette={palette}
                  visibility={visibility}
                  ranks={ranks}
                  selected={selected}
                  primary={primary}
                  neighbours={neighbours}
                  drawStyle={style}
                  onPick={pick}
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
        ) : (
          <GraphTable
            model={model}
            view={view}
            visibility={visibility}
            selected={selected}
            onSelect={pick}
            title={title}
          />
        )}
        {showSheet ? (
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
      {legend.length > 1 || graph.property !== null ? (
        <Legend
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

/** The layout of the drawing, chosen per view: forces or layers. */
function LayoutChoice({
  value,
  onChange,
}: {
  value: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <span className="graph__layout">
      <label className="graph__layout-label" htmlFor={id}>
        {t("graph.layout.label")}
      </label>
      <select
        id={id}
        className="select graph__layout-select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as LayoutMode)}
      >
        <option value="force">{t("graph.layout.force")}</option>
        <option value="hierarchy">{t("graph.layout.hierarchy")}</option>
      </select>
    </span>
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
  drawStyle: DrawStyle;
  onPick: (node: number | null, additive: boolean) => void;
  onGestureHint: (gesture: "wheel" | "touch") => void;
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
