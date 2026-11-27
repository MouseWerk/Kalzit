import { elkInput, elkPositions } from "./elkGraph";
import type { LayoutGraph } from "./layoutEngine";
import type { ElkSettings } from "./options";

/**
 * The optional ELK layout of the hierarchy panel. elkjs loads on the first layout that asks for
 * it (`import()` of elkRunner.ts, a chunk of its own); Kalzit's own layered layout stays the
 * default. ELK runs only in a worker, on graphs up to the hierarchy's limit; a browser without
 * workers keeps Kalzit's layout with a notice, so ELK ships once (elkRunner.ts).
 */

export type ElkRunner = Pick<typeof import("./elkRunner"), "layoutInWorker">;

const defaultLoader = (): Promise<ElkRunner> => import("./elkRunner");
let loadRunner: () => Promise<ElkRunner> = defaultLoader;

/** For tests: how elkjs is loaded. Returns a function that restores the default. */
export function setElkLoader(loader: () => Promise<ElkRunner>): () => void {
  loadRunner = loader;
  return () => {
    loadRunner = defaultLoader;
  };
}

/** Why ELK gave no layout; the panel then shows Kalzit's own and says so. */
export class ElkUnavailable extends Error {
  constructor(readonly reason: "failed" | "noWorker") {
    super(reason === "noWorker" ? "ELK needs a web worker" : "ELK failed");
  }
}

/**
 * Lays out `graph` with ELK. The graph is read before the first `await`, so the caller may hand
 * its arrays on afterwards (to the fallback's worker). Rejects with ElkUnavailable, or with an
 * AbortError once `signal` is aborted.
 */
export async function elkLayout(
  graph: LayoutGraph,
  settings: ElkSettings,
  signal: AbortSignal,
  worker: boolean,
): Promise<{ positions: Float32Array; reversed: number }> {
  if (!worker) {
    throw new ElkUnavailable("noWorker");
  }
  const input = elkInput(graph, settings);
  const sizes = graph.sizes.slice();
  const labels = graph.labels?.slice();
  const shape: LayoutGraph = {
    count: graph.count,
    sources: graph.sources.slice(),
    targets: graph.targets.slice(),
    weights: graph.weights.slice(),
    sizes,
    ...(labels === undefined ? {} : { labels }),
  };
  try {
    const runner = await loadRunner();
    signal.throwIfAborted();
    const result = await runner.layoutInWorker(input, signal);
    signal.throwIfAborted();
    return elkPositions(result, shape, settings.direction);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
      // biome-ignore lint/suspicious/noConsole: a note for developers only, never in a build
      console.warn("ELK layout failed; the panel shows Kalzit's layout", error);
    }
    throw new ElkUnavailable("failed");
  }
}
