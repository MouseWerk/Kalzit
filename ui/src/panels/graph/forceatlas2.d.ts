// The single-iteration module of graphology-layout-forceatlas2, which ships no types for it. The
// layout runs it on flat matrices in the layout worker (layoutEngine.ts).
declare module "graphology-layout-forceatlas2/iterate.js" {
  export default function iterate(
    settings: Record<string, number | boolean>,
    nodes: Float32Array,
    edges: Float32Array,
  ): unknown;
}
