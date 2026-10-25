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
import { setVariableFromClick, usePanelHost } from "../host";
import { EmptyPanel } from "../shared";
import type { PanelGraph, PanelProps } from "../types";
import { propertyText } from "./adapter";
import { type GraphPalette, prefersReducedMotion, readPalette, useThemeVersion } from "./colors";
import type { Direction } from "./drawing";
import { GraphTable } from "./GraphTable";
import type { LayoutMode } from "./layoutProtocol";
import { COMMUNITY_LIMIT, type Communities, communities, components } from "./metrics";
import { buildGraphModel, edgeTimes, edgeWidths, GRAPH_COLORS, nodeSizes } from "./model";
import { AUTO_CLUSTER_EDGES, AUTO_CLUSTER_NODES, type GraphPanelOptions } from "./options";
import { countText } from "./plural";
import type { CanvasHandle } from "./SigmaCanvas";
import { type Explorer, type ExplorerStep, useExplorer } from "./useExplorer";
import { useGraphLayout } from "./useGraphLayout";
import {
  allVisible,
  buildView,
  type GraphView,
  labelRanks,
  shouldCluster,
  timeSteps,
  visibleAt,
} from "./view";
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

interface GraphPanelProps extends PanelProps<GraphPanelOptions> {
  mode: LayoutMode;
}

/**
 * The network and hierarchy panels: a graph drawn with WebGL, the same graph as tables for
 * screen readers (and where WebGL is missing), selection, explorer mode, the time slider and
 * graph metrics. Explorer mode needs the organization; elsewhere the panel draws what it has.
 */
export function GraphPanel(props: GraphPanelProps) {
  const host = usePanelHost();
  const graphs = props.graphs ?? [];
  if (graphs.length === 0) {
    return <EmptyPanel reason="noData" />;
  }
  if (props.options.explorer && host.orgId !== undefined) {
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
  const sizes = useMemo(() => nodeSizes(model, options.sizeBy), [model, options.sizeBy]);
  const widths = useMemo(
    () => edgeWidths(model, options.edgeWidthBy),
    [model, options.edgeWidthBy],
  );
  const groups = useMemo(() => {
    const of =
      options.colorBy === "component"
        ? parts.of
        : options.colorBy === "community" &&
            found !== null &&
            found.of.length === model.nodes.length
          ? found.of
          : null;
    return Int32Array.from(model.nodes, (node, i) =>
      of === null ? (node.label < 0 ? -1 : node.label % GRAPH_COLORS) : (of[i] ?? 0) % GRAPH_COLORS,
    );
  }, [model, parts, found, options.colorBy]);
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
      }),
    [model, sizes, widths, groups, cluster, open, clusterText, unlabelled],
  );
  const times = useMemo(
    () => edgeTimes(model, options.timeProperty),
    [model, options.timeProperty],
  );
  const steps = useMemo(() => timeSteps(times), [times]);
  const ranks = useMemo(() => labelRanks(view), [view]);
  return { model, parts, view, times, steps, ranks };
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Whether the focus is inside the panel; Escape clears the selection only then.
  const rootRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
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

  const steps = explorer?.steps ?? NO_STEPS;
  const sets = useSameList([...graphs.map((g) => g.graph), ...steps.map((s) => s.graph)]);
  // Stable per language, so the view is not rebuilt on every render.
  const texts = useMemo(() => {
    const format = new Intl.NumberFormat(language);
    return {
      cluster: (label: string, members: number) =>
        translate(language, "graph.cluster.caption", { label, count: format.format(members) }),
      unlabelled: translate(language, "graph.cluster.unlabelled"),
    };
  }, [language]);
  const graph = useGraph(sets, options, mode, open, unclustered, texts, found);
  const { model, parts, view, times, ranks } = graph;

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
  }, [themeVersion, display]);

  useEffect(() => {
    if (gestureHint === null) return;
    const timer = setTimeout(() => setGestureHint(null), 2_000);
    return () => clearTimeout(timer);
  }, [gestureHint]);

  const timeAt = timeIndex === null ? null : (graph.steps[timeIndex] ?? null);
  const visibility = useMemo(
    () => (timeAt === null ? allVisible(view) : visibleAt(model, view, times, timeAt)),
    [model, view, times, timeAt],
  );

  const viewIndex = useMemo(() => new Map(view.nodes.map((node, i) => [node.key, i])), [view]);
  const selected = selectedKey === null ? null : (viewIndex.get(selectedKey) ?? null);
  const neighbours = useMemo(() => {
    const set = new Set<number>();
    if (selected !== null) {
      for (const edge of view.edges) {
        if (edge.source === selected) set.add(edge.target);
        if (edge.target === selected) set.add(edge.source);
      }
    }
    return set;
  }, [view, selected]);

  // Escape clears the selection only while the panel has the focus, and the selection does not
  // hold back the shell's shortcuts: Ctrl+K, ?, / and F6 still work after clicking a node.
  useEscapeLayer(focused && selected !== null, () => select(null), { blocking: false });

  const selectedNode = selected === null ? undefined : view.nodes[selected];
  const modelNode =
    selectedNode !== undefined && selectedNode.node >= 0
      ? model.nodes[selectedNode.node]
      : undefined;
  const variable =
    options.variable !== "" && host.variables?.names.includes(options.variable) === true
      ? options.variable
      : null;

  function describe(index: number): string {
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

  function select(index: number | null) {
    const node = index === null ? undefined : view.nodes[index];
    setSelectedKey(node?.key ?? null);
    setAnnouncement(index === null ? t("graph.announce.cleared") : describe(index));
    if (index !== null) canvasRef.current?.reveal(index);
  }

  /** A click or Enter on a node: open a group, expand in explorer mode, set the variable. */
  function activate(index: number) {
    const node = view.nodes[index];
    if (node === undefined) return;
    if (node.node < 0) {
      setOpen((current) => new Set([...current, node.cluster]));
      setAnnouncement(t("graph.announce.opened", { name: node.caption }));
      return;
    }
    const data = model.nodes[node.node];
    if (data === undefined) return;
    if (variable !== null) {
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
    if (
      explorer !== null &&
      explorer.unavailable === null &&
      !explorer.steps.some((s) => s.nodeId === data.id)
    ) {
      explorer.expand(data.id, data.caption);
    }
  }

  function pick(index: number | null) {
    select(index);
    if (index !== null) activate(index);
  }

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    const directions: Record<string, Direction> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    const direction = directions[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      const next = canvasRef.current?.nodeToward(selected, direction) ?? null;
      if (next !== null) select(next);
      return;
    }
    if (event.key === "Enter" && selected !== null && !isComposingKey(event)) {
      event.preventDefault();
      activate(selected);
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

  const drawn = display === "graph" && DRAWABLE;

  return (
    <div className="graph" ref={rootRef}>
      <div className="graph__toolbar" role="toolbar" aria-label={t("graph.toolbar", { title })}>
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
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setDisplay(display === "graph" ? "table" : "graph")}
          >
            {display === "graph" ? t("graph.showTable") : t("graph.showDrawing")}
          </button>
        ) : null}
        {explorer !== null && (explorer.steps.length > 0 || explorer.pending !== null) ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => {
              // The newest step is the one still loading, if any.
              const name = explorer.pendingCaption ?? explorer.steps.at(-1)?.caption ?? "";
              explorer.undo();
              setAnnouncement(t("graph.announce.undone", { name }));
            }}
          >
            {t("graph.explorer.undo", {
              name: explorer.pendingCaption ?? explorer.steps.at(-1)?.caption ?? "",
            })}
          </button>
        ) : null}
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
        {model.nodes.length > COMMUNITY_LIMIT
          ? t("graph.communities.tooLarge", { limit: number.format(COMMUNITY_LIMIT) })
          : found === null
            ? ""
            : t("graph.communities.count", {
                communities: countText(t, language, "community", found.count),
              })}
      </p>
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
      {explorer?.unavailable === "kind" ? (
        <p className="graph__note">{t("graph.explorer.noKind")}</p>
      ) : null}
      {explorer?.unavailable === "right" ? (
        <p className="graph__note">{t("graph.explorer.noRight")}</p>
      ) : null}
      {explorer?.error ? (
        <p className="graph__note graph__note--error" role="alert">
          {explorer.error}
        </p>
      ) : null}
      {graph.steps.length > 1 ? (
        <TimeSlider steps={graph.steps} index={timeIndex} onChange={setTimeIndex} />
      ) : null}
      <div className="graph__body">
        {drawn ? (
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
                  mode={mode}
                  palette={palette}
                  visibility={visibility}
                  ranks={ranks}
                  selected={selected}
                  neighbours={neighbours}
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
        {selectedNode === undefined ? null : (
          <section
            className="graph__details"
            aria-label={t("graph.details", { name: selectedNode.caption })}
          >
            <h3 className="graph__details-title">{selectedNode.caption}</h3>
            {modelNode === undefined ? (
              <>
                <p className="graph__note">
                  {t("graph.cluster.members", { count: number.format(selectedNode.members) })}
                </p>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => activate(selected as number)}
                >
                  {t("graph.cluster.open")}
                </button>
              </>
            ) : (
              <>
                <dl className="graph__properties">
                  <div>
                    <dt>{t("graph.table.labels")}</dt>
                    <dd>{modelNode.labels.join(", ") || "–"}</dd>
                  </div>
                  <div>
                    <dt>{t("graph.metric.degree")}</dt>
                    <dd>
                      {t("graph.metric.degreeValue", {
                        count: number.format(modelNode.degree),
                        in: number.format(modelNode.inDegree),
                        out: number.format(modelNode.outDegree),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("graph.metric.component")}</dt>
                    <dd>
                      {t("graph.metric.componentValue", {
                        number: number.format((parts.of[selectedNode.node] ?? 0) + 1),
                        count: number.format(parts.sizes[parts.of[selectedNode.node] ?? 0] ?? 0),
                      })}
                    </dd>
                  </div>
                  {found === null ? null : (
                    <div>
                      <dt>{t("graph.metric.community")}</dt>
                      <dd>{number.format((found.of[selectedNode.node] ?? 0) + 1)}</dd>
                    </div>
                  )}
                  {Object.entries(modelNode.properties).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{propertyText(value)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="graph__actions">
                  {explorer !== null && explorer.unavailable === null ? (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      disabled={
                        explorer.pending !== null ||
                        explorer.steps.some((s) => s.nodeId === modelNode.id)
                      }
                      onClick={() => explorer.expand(modelNode.id, modelNode.caption)}
                    >
                      {explorer.pending === modelNode.id
                        ? t("graph.explorer.loading")
                        : t("graph.explorer.expand")}
                    </button>
                  ) : null}
                  {variable === null ? null : (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => activate(selected as number)}
                    >
                      {t("graph.variable.set", { name: variable })}
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
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
    "neutral",
    "edge",
    "text",
    "bg",
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
  palette: GraphPalette;
  visibility: ReturnType<typeof allVisible>;
  ranks: Int32Array;
  selected: number | null;
  neighbours: ReadonlySet<number>;
  onPick: (node: number | null) => void;
  onGestureHint: (gesture: "wheel" | "touch") => void;
  camera: { current: CameraState | null };
  ref: Ref<CanvasHandle>;
}

/** The drawing with its layout. With reduced motion, nodes jump to where the layout settles. */
function DrawnGraph({ view, mode, ref, ...rest }: DrawnGraphProps) {
  const layout = useGraphLayout(view, mode);
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
      <LazySigmaCanvas ref={ref} view={view} positions={shown} reducedMotion={reduced} {...rest} />
      {mode === "hierarchy" && layout.reversed > 0 ? <CycleNote count={layout.reversed} /> : null}
      {layout.running && !progressive ? <SettlingNote /> : null}
    </>
  );
}

/** Graphs above this many nodes are drawn when their layout has settled, not while it moves. */
export const PROGRESSIVE_NODES = 2_000;

function SettlingNote() {
  const { t } = useI18n();
  return (
    <p className="graph__overlay-note" role="status">
      {t("graph.layout.settling")}
    </p>
  );
}

function CycleNote({ count }: { count: number }) {
  const { t, language } = useI18n();
  return (
    <p className="graph__overlay-note">
      {t("graph.notice.cycles", { count: new Intl.NumberFormat(language).format(count) })}
    </p>
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
