import { useEffect, useRef, useState } from "react";
import { ElkUnavailable, elkLayout } from "./elkLayout";
import { ForceLayout, forceIterations, seedPositions } from "./layoutEngine";
import type { LayoutGuide, LayoutMessage, LayoutMode, LayoutRequest } from "./layoutProtocol";
import type { LayoutInput } from "./layouts/inputs";
import { placeLayout } from "./layouts/place";
import type { ElkSettings } from "./options";
import { NO_PINNED_NODES, type PinnedPositions } from "./pinned";
import type { GraphView } from "./view";

/**
 * Runs the layout of a view and keeps its newest positions. Layouts run in a worker; where
 * there is none, small graphs are laid out on the main thread (the force layout in slices of
 * SLICE_MS) and larger ones keep their starting positions, so the page never freezes either way.
 */

/** Main-thread work per slice when no worker is available. */
export const SLICE_MS = 8;
/** Without a worker, force layouts run only up to this many nodes. */
export const MAIN_THREAD_FORCE_LIMIT = 1_000;
export const MAIN_THREAD_HIERARCHY_LIMIT = 2_000;
/**
 * ELK lays out at most this many nodes: beyond it its layered algorithm takes minutes, and
 * Kalzit's own layers, which reach HIERARCHY_NODE_LIMIT, take over in the direction asked for.
 */
export const ELK_NODE_LIMIT = 2_000;

export type WorkerFactory = () => Worker | null;

function defaultFactory(): Worker | null {
  if (typeof Worker === "undefined") {
    return null;
  }
  try {
    return new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}

let createWorker: WorkerFactory = defaultFactory;

/** For tests: how layout workers are made. Returns a function that restores the default. */
export function setLayoutWorkerFactory(factory: WorkerFactory): () => void {
  createWorker = factory;
  return () => {
    createWorker = defaultFactory;
  };
}

/**
 * Why a hierarchy that asked for ELK shows Kalzit's layout: ELK failed (or could not load), the
 * graph is too large for ELK without a worker, or it has more nodes than ELK lays out at all.
 */
export type ElkNotice = "elkFailed" | "elkTooLarge" | "elkAboveLimit";

export interface LayoutState {
  positions: Float32Array | null;
  running: boolean;
  /** Hierarchy: edges reversed to break cycles. */
  reversed: number;
  /** Whether positions come from a worker (false: main thread, or none). */
  worker: boolean;
  /** Which layout the positions come from; "elk" while ELK loads and runs, too. */
  engine: "kalzit" | "elk";
  notice: ElkNotice | null;
  /**
   * How far a layout that answers once has come, in nodes (the worker says it a few times a
   * second); null for the force layout, which shows its positions instead, and when none runs.
   */
  work: { done: number; total: number } | null;
  /** The lines the layout draws behind the graph: rings, axes, lanes, its strip. */
  guides: readonly LayoutGuide[];
}

/** What a layout takes besides the view: all optional, a force layout or hierarchy needs none. */
export interface LayoutExtras {
  /** What the layout reads from the result (layouts/inputs.ts). */
  input?: LayoutInput | undefined;
  /** Pinned nodes by node id; the layout leaves them where they are (pinned.ts). */
  pinned?: PinnedPositions | undefined;
  /** "Arrange again" asks with another seed (layoutProtocol.ts). */
  seed?: number | undefined;
  /** Where a hierarchy's edges point when Kalzit lays it out itself. */
  direction?: LayoutRequest["direction"];
}

const NO_GUIDES: readonly LayoutGuide[] = [];

/** Average width of a label's character in px, at the renderer's label size. */
const LABEL_CHAR_PX = 8;
/** Longer labels count as this many characters: a layer is not spread for one long name. */
const LABEL_CHARS = 24;

/** The width a node's label takes beside it, estimated from its length. */
export function labelWidth(caption: string): number {
  return Math.min(caption.length, LABEL_CHARS) * LABEL_CHAR_PX;
}

/**
 * The layout input of a view, with nodes already placed starting where they were and pinned
 * nodes fixed at their kept positions. The arrays are the request's own (the worker takes them).
 */
export function layoutRequest(
  view: GraphView,
  mode: LayoutMode,
  run: number,
  placed: ReadonlyMap<string, readonly [number, number]>,
  extras: LayoutExtras = {},
): LayoutRequest {
  const count = view.nodes.length;
  const sources = new Uint32Array(view.edges.length);
  const targets = new Uint32Array(view.edges.length);
  view.edges.forEach((edge, i) => {
    sources[i] = edge.source;
    targets[i] = edge.target;
  });
  const sizes = Float32Array.from(view.nodes, (node) => node.size);
  const labels = Float32Array.from(view.nodes, (node) => labelWidth(node.caption));
  const seed = extras.seed ?? 0;
  const start = seedPositions(count, undefined, seed);
  if (placed.size > 0) {
    // A node seen before starts where it was; a new one next to a placed neighbour.
    const known = new Uint8Array(count);
    view.nodes.forEach((node, i) => {
      const at = placed.get(node.key);
      if (at !== undefined) {
        start[2 * i] = at[0];
        start[2 * i + 1] = at[1];
        known[i] = 1;
      }
    });
    view.edges.forEach((edge) => {
      for (const [from, to] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ] as const) {
        if (known[from] === 1 && known[to] === 0) {
          const jitter = ((to * 7919) % 360) * (Math.PI / 180);
          start[2 * to] = (start[2 * from] as number) + 12 * Math.cos(jitter);
          start[2 * to + 1] = (start[2 * from + 1] as number) + 12 * Math.sin(jitter);
          known[to] = 2;
        }
      }
    });
  }
  // A pinned node starts, and stays, at its kept position. Groups have no id of their own.
  let fixed: Uint8Array | undefined;
  const pinned = extras.pinned;
  if (pinned !== undefined && pinned.size > 0) {
    view.nodes.forEach((node, i) => {
      const at = node.node < 0 ? undefined : pinned.get(node.key.slice(2));
      if (at === undefined) return;
      fixed ??= new Uint8Array(count);
      fixed[i] = 1;
      start[2 * i] = at[0];
      start[2 * i + 1] = at[1];
    });
  }
  const input = extras.input ?? {};
  return {
    type: "start",
    run,
    mode,
    count,
    sources,
    targets,
    weights: new Float32Array(view.edges.length).fill(1),
    sizes,
    labels,
    start,
    seed,
    ...(fixed === undefined ? {} : { fixed }),
    ...(extras.direction === undefined ? {} : { direction: extras.direction }),
    // Copies: the plan keeps its arrays for the next run, the request's go to the worker.
    ...(input.centers === undefined ? {} : { centers: input.centers.slice() }),
    ...(input.order === undefined ? {} : { order: input.order.slice() }),
    ...(input.values === undefined ? {} : { values: input.values.slice() }),
    ...(input.uniform === undefined ? {} : { uniform: input.uniform }),
    ...(input.times === undefined ? {} : { times: input.times.slice() }),
    ...(input.lanes === undefined ? {} : { lanes: input.lanes.slice() }),
  };
}

/** The buffers of a request, handed to the worker with it. */
function buffersOf(request: LayoutRequest): Transferable[] {
  const arrays = [
    request.sources,
    request.targets,
    request.weights,
    request.sizes,
    request.labels,
    request.start,
    request.fixed,
    request.centers,
    request.order,
    request.values,
    request.times,
    request.lanes,
  ];
  return arrays.flatMap((array) => (array === undefined ? [] : [array.buffer]));
}

/** What Kalzit's own layouts report as they go. */
type KalzitProgress = Pick<
  LayoutState,
  "positions" | "running" | "reversed" | "worker" | "work" | "guides"
>;

/**
 * Runs Kalzit's own layout of `request`: in a worker, or without one in slices on the main thread
 * (small graphs only). Returns the cleanup that stops it.
 */
function runKalzit(
  request: LayoutRequest,
  mode: LayoutMode,
  remember: (positions: Float32Array) => void,
  update: (progress: KalzitProgress) => void,
): (() => void) | undefined {
  const run = request.run;
  const idle = { reversed: 0, work: null, guides: NO_GUIDES };
  const worker = createWorker();
  if (worker !== null) {
    // The request's arrays move to the worker; the panel draws a copy of the start meanwhile:
    // for nodes already placed that is where they were, so the old drawing stays until the new
    // one is there.
    const shown = request.start.slice();
    const once = mode !== "force";
    const total = request.count;
    update({
      ...idle,
      positions: shown,
      running: true,
      worker: true,
      work: once ? { done: 0, total } : null,
    });
    worker.onmessage = (event: MessageEvent<LayoutMessage>) => {
      const message = event.data;
      if (message.run !== run) {
        return;
      }
      if (message.type === "work") {
        update({
          ...idle,
          positions: shown,
          running: true,
          worker: true,
          work: { done: message.done, total: message.total },
        });
        return;
      }
      if (message.done) {
        remember(message.positions);
      }
      update({
        positions: message.positions,
        running: !message.done,
        reversed: message.reversed ?? 0,
        worker: true,
        work: null,
        guides: message.guides ?? NO_GUIDES,
      });
    };
    worker.postMessage(request, buffersOf(request));
    return () => {
      worker.terminate();
    };
  }

  // No worker: on the main thread, small graphs only.
  if (mode !== "force") {
    // A hierarchy of thousands of nodes would hold the page; the others place in one pass.
    if (mode === "hierarchy" && request.count > MAIN_THREAD_HIERARCHY_LIMIT) {
      update({ ...idle, positions: request.start, running: false, worker: false });
      return;
    }
    const result = placeLayout(request);
    remember(result.positions);
    update({
      positions: result.positions,
      running: false,
      reversed: result.reversed,
      worker: false,
      work: null,
      guides: result.guides,
    });
    return;
  }
  if (request.count > MAIN_THREAD_FORCE_LIMIT) {
    update({ ...idle, positions: request.start, running: false, worker: false });
    return;
  }
  const layout = new ForceLayout(request, request.start);
  const total = forceIterations(request.count);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slice = () => {
    const started = performance.now();
    do {
      layout.step(1);
    } while (layout.done < total && performance.now() - started < SLICE_MS);
    const positions = layout.positions();
    const done = layout.done >= total;
    if (done) remember(positions);
    update({ ...idle, positions, running: !done, worker: false });
    if (!done) timer = setTimeout(slice, 0);
  };
  update({ ...idle, positions: request.start, running: true, worker: false });
  timer = setTimeout(slice, 0);
  return () => clearTimeout(timer);
}

/** What a finished layout was computed from: asked for again, it is shown without a new run. */
interface Settled {
  view: GraphView;
  input: LayoutInput | undefined;
  pinned: PinnedPositions;
  key: string;
  state: LayoutState;
}

/**
 * The layout of a view. A hierarchy with `elk` settings is laid out by ELK, loaded on first use;
 * while it loads and runs the nodes stand at their start, and when ELK fails (or the graph is too
 * large for it) Kalzit's own layout takes over with a notice. A layout that is left before it
 * finished (cancelled, or replaced by the one before it) costs nothing: the last finished one is
 * shown again as it was.
 */
export function useGraphLayout(
  view: GraphView,
  mode: LayoutMode,
  elk: ElkSettings | null = null,
  extras: LayoutExtras = {},
): LayoutState {
  const [state, setState] = useState<LayoutState>({
    positions: null,
    running: false,
    reversed: 0,
    worker: false,
    engine: "kalzit",
    notice: null,
    work: null,
    guides: NO_GUIDES,
  });
  const placed = useRef(new Map<string, [number, number]>());
  const runs = useRef(0);
  const settled = useRef<Settled | null>(null);
  const lastSeed = useRef(extras.seed ?? 0);
  // The settings as values, so a new object with the same settings starts no new layout.
  const useElk = mode === "hierarchy" && elk !== null;
  const direction = elk?.direction ?? extras.direction ?? "down";
  const nodeSpacing = elk?.nodeSpacing ?? 0;
  const layerSpacing = elk?.layerSpacing ?? 0;
  const edgeRouting = elk?.edgeRouting ?? "orthogonal";
  const input = extras.input;
  const pinned = extras.pinned ?? NO_PINNED_NODES.positions;
  const seed = extras.seed ?? 0;

  useEffect(() => {
    const key = [mode, seed, useElk, direction, nodeSpacing, layerSpacing, edgeRouting].join("|");
    const known = settled.current;
    if (
      known !== null &&
      known.view === view &&
      known.input === input &&
      known.pinned === pinned &&
      known.key === key
    ) {
      setState(known.state);
      return;
    }
    const run = ++runs.current;
    // "Arrange again" starts a force layout from its seed, not from where the nodes are.
    const fresh = mode === "force" && seed !== lastSeed.current;
    lastSeed.current = seed;
    const request = layoutRequest(view, mode, run, fresh ? new Map() : placed.current, {
      input,
      pinned,
      seed,
      direction,
    });
    const remember = (positions: Float32Array) => {
      const map = new Map<string, [number, number]>();
      view.nodes.forEach((node, i) => {
        map.set(node.key, [positions[2 * i] as number, positions[2 * i + 1] as number]);
      });
      placed.current = map;
    };
    const show = (next: LayoutState) => {
      if (!next.running) settled.current = { view, input, pinned, key, state: next };
      setState(next);
    };
    const kalzit = (notice: ElkNotice | null) =>
      runKalzit(request, mode, remember, (progress) =>
        show({ ...progress, engine: "kalzit", notice }),
      );
    if (!useElk) {
      return kalzit(null);
    }
    if (request.count > ELK_NODE_LIMIT) {
      return kalzit("elkAboveLimit");
    }

    const settings: ElkSettings = { direction, nodeSpacing, layerSpacing, edgeRouting };
    const worker = typeof Worker !== "undefined";
    const controller = new AbortController();
    let stop: (() => void) | undefined;
    setState({
      positions: request.start.slice(),
      running: true,
      reversed: 0,
      worker,
      engine: "elk",
      notice: null,
      work: null,
      guides: NO_GUIDES,
    });
    elkLayout(request, settings, controller.signal, worker).then(
      (result) => {
        if (controller.signal.aborted) return;
        remember(result.positions);
        show({
          positions: result.positions,
          running: false,
          reversed: result.reversed,
          worker,
          engine: "elk",
          notice: null,
          work: null,
          guides: NO_GUIDES,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const tooLarge = error instanceof ElkUnavailable && error.reason === "tooLarge";
        stop = kalzit(tooLarge ? "elkTooLarge" : "elkFailed");
      },
    );
    return () => {
      controller.abort();
      stop?.();
    };
  }, [view, mode, useElk, direction, nodeSpacing, layerSpacing, edgeRouting, input, pinned, seed]);

  return state;
}
