import { useEffect, useRef, useState } from "react";
import { ForceLayout, forceIterations, hierarchyLayout, seedPositions } from "./layoutEngine";
import type { LayoutMode, LayoutProgress, LayoutRequest } from "./layoutProtocol";
import type { GraphView } from "./view";

/**
 * Runs the layout of a view and keeps its newest positions. Layouts run in a worker; where
 * there is none, small graphs are laid out on the main thread in slices of SLICE_MS and larger
 * ones keep their starting positions, so the page never freezes either way.
 */

/** Main-thread work per slice when no worker is available. */
export const SLICE_MS = 8;
/** Without a worker, force layouts run only up to this many nodes. */
export const MAIN_THREAD_FORCE_LIMIT = 1_000;
export const MAIN_THREAD_HIERARCHY_LIMIT = 2_000;

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

export interface LayoutState {
  positions: Float32Array | null;
  running: boolean;
  /** Hierarchy: edges reversed to break cycles. */
  reversed: number;
  /** Whether positions come from a worker (false: main thread, or none). */
  worker: boolean;
}

/** Average width of a label's character in px, at the renderer's label size. */
const LABEL_CHAR_PX = 8;
/** Longer labels count as this many characters: a layer is not spread for one long name. */
const LABEL_CHARS = 24;

/** The width a node's label takes beside it, estimated from its length. */
export function labelWidth(caption: string): number {
  return Math.min(caption.length, LABEL_CHARS) * LABEL_CHAR_PX;
}

/** The layout input of a view, with nodes already placed starting where they were. */
export function layoutRequest(
  view: GraphView,
  mode: LayoutMode,
  run: number,
  placed: ReadonlyMap<string, [number, number]>,
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
  const start = seedPositions(count);
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
  };
}

export function useGraphLayout(view: GraphView, mode: LayoutMode): LayoutState {
  const [state, setState] = useState<LayoutState>({
    positions: null,
    running: false,
    reversed: 0,
    worker: false,
  });
  const placed = useRef(new Map<string, [number, number]>());
  const runs = useRef(0);

  useEffect(() => {
    const run = ++runs.current;
    const request = layoutRequest(view, mode, run, placed.current);
    const remember = (positions: Float32Array) => {
      const map = new Map<string, [number, number]>();
      view.nodes.forEach((node, i) => {
        map.set(node.key, [positions[2 * i] as number, positions[2 * i + 1] as number]);
      });
      placed.current = map;
    };
    const worker = createWorker();
    if (worker !== null) {
      // The request's arrays move to the worker; the panel draws a copy of the start meanwhile.
      setState({ positions: request.start.slice(), running: true, reversed: 0, worker: true });
      worker.onmessage = (event: MessageEvent<LayoutProgress>) => {
        const message = event.data;
        if (message.run !== run) {
          return;
        }
        if (message.done) {
          remember(message.positions);
        }
        setState({
          positions: message.positions,
          running: !message.done,
          reversed: message.reversed ?? 0,
          worker: true,
        });
      };
      worker.postMessage(request, [
        request.sources.buffer,
        request.targets.buffer,
        request.weights.buffer,
        request.sizes.buffer,
        request.labels.buffer,
        request.start.buffer,
      ]);
      return () => {
        worker.terminate();
      };
    }

    // No worker: slices on the main thread, small graphs only.
    if (mode === "hierarchy") {
      if (request.count > MAIN_THREAD_HIERARCHY_LIMIT) {
        setState({ positions: request.start, running: false, reversed: 0, worker: false });
        return;
      }
      const result = hierarchyLayout(request);
      remember(result.positions);
      setState({
        positions: result.positions,
        running: false,
        reversed: result.reversed,
        worker: false,
      });
      return;
    }
    if (request.count > MAIN_THREAD_FORCE_LIMIT) {
      setState({ positions: request.start, running: false, reversed: 0, worker: false });
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
      setState({ positions, running: !done, reversed: 0, worker: false });
      if (!done) timer = setTimeout(slice, 0);
    };
    setState({ positions: request.start, running: true, reversed: 0, worker: false });
    timer = setTimeout(slice, 0);
    return () => clearTimeout(timer);
  }, [view, mode]);

  return state;
}
