import type Graph from "graphology";

/**
 * Writes interleaved layout positions onto a graphology graph whose nodes are keyed by index:
 * the step a layout update costs the main thread.
 */
export function applyPositionsTo(graph: Graph, positions: Float32Array): void {
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
