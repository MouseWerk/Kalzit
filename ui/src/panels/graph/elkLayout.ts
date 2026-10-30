import { elkInput, elkPositions } from "./elkGraph";
import type { LayoutGraph } from "./layoutEngine";
import type { ElkSettings } from "./options";

/**
 * The optional ELK layout of the hierarchy panel. elkjs loads on the first layout that asks for
 * it (`import()` of elkRunner.ts, a chunk of its own); Kalzit's own layered layout stays the
 * default. In a worker ELK takes graphs up to the hierarchy's limit; without workers it runs on
 * the page, so only small graphs, and larger ones keep Kalzit's layout with a notice.
 */

/** Without a worker, ELK lays out at most this many nodes on the page. */
export const MAIN_THREAD_ELK_LIMIT = 300;

export type ElkRunner = Pick<typeof import("./elkRunner"), "layoutInWorker" | "layoutOnMainThread">;

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
  constructor(readonly reason: "failed" | "tooLarge") {
    super(reason === "tooLarge" ? "Too many nodes for ELK without a worker" : "ELK failed");
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
  if (!worker && graph.count > MAIN_THREAD_ELK_LIMIT) {
    throw new ElkUnavailable("tooLarge");
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
    const result = worker
      ? await runner.layoutInWorker(input, signal)
      : await runner.layoutOnMainThread(input);
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
