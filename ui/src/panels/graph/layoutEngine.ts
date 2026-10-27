import iterate from "graphology-layout-forceatlas2/iterate.js";

/**
 * Layout algorithms on flat typed arrays, so they run the same in the layout worker and, for
 * small graphs where no worker is available, on the main thread in short slices. Positions are
 * interleaved `x0, y0, x1, y1, ...`.
 */

export interface LayoutGraph {
  count: number;
  sources: Uint32Array;
  targets: Uint32Array;
  /** Per edge; 1 when the panel weighs edges equally. */
  weights: Float32Array;
  /** Per node, for the force layout's size adjustment and the hierarchy's spacing; px. */
  sizes: Float32Array;
  /**
   * Per node, the width its label takes beside it in px (an estimate); the hierarchy spaces the
   * nodes of a layer by it. Absent: no labels.
   */
  labels?: Float32Array;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Starting positions on a sunflower spiral: deterministic, evenly spread and without overlaps, so
 * the force layout starts calm and the same data always settles the same way.
 */
export function seedPositions(count: number, previous?: Float32Array): Float32Array {
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const r = 10 * Math.sqrt(i + 0.5);
    out[2 * i] = r * Math.cos(i * GOLDEN_ANGLE);
    out[2 * i + 1] = r * Math.sin(i * GOLDEN_ANGLE);
  }
  if (previous !== undefined) {
    out.set(previous.subarray(0, Math.min(previous.length, out.length)));
  }
  return out;
}

// The ForceAtlas2 matrix layout of graphology-layout-forceatlas2 (iterate.js).
const PPN = 10;
const PPE = 3;
const NODE_MASS = 6;
const NODE_CONVERGENCE = 7;
const NODE_SIZE = 8;

/** Iterations a force layout runs for a graph of `count` nodes: fewer for large ones. */
export function forceIterations(count: number): number {
  if (count <= 500) return 400;
  if (count <= 2_000) return 250;
  return 150;
}

/** ForceAtlas2 as graphology-layout-forceatlas2 infers its settings, with Barnes-Hut above 1,000. */
export class ForceLayout {
  private readonly nodes: Float32Array;
  private readonly edges: Float32Array;
  private readonly settings: Record<string, number | boolean>;
  done = 0;

  constructor(graph: LayoutGraph, start: Float32Array) {
    const { count } = graph;
    this.nodes = new Float32Array(count * PPN);
    for (let i = 0; i < count; i++) {
      const at = i * PPN;
      this.nodes[at] = start[2 * i] ?? 0;
      this.nodes[at + 1] = start[2 * i + 1] ?? 0;
      this.nodes[at + NODE_MASS] = 1;
      this.nodes[at + NODE_CONVERGENCE] = 1;
      this.nodes[at + NODE_SIZE] = graph.sizes[i] ?? 1;
    }
    const size = graph.sources.length;
    this.edges = new Float32Array(size * PPE);
    for (let e = 0; e < size; e++) {
      const s = (graph.sources[e] as number) * PPN;
      const t = (graph.targets[e] as number) * PPN;
      const w = graph.weights[e] ?? 1;
      this.nodes[s + NODE_MASS] = (this.nodes[s + NODE_MASS] as number) + w;
      this.nodes[t + NODE_MASS] = (this.nodes[t + NODE_MASS] as number) + w;
      this.edges[e * PPE] = s;
      this.edges[e * PPE + 1] = t;
      this.edges[e * PPE + 2] = w;
    }
    this.settings = {
      linLogMode: false,
      outboundAttractionDistribution: false,
      adjustSizes: false,
      edgeWeightInfluence: 1,
      scalingRatio: 10,
      strongGravityMode: true,
      gravity: 0.05,
      slowDown: 1 + Math.log(Math.max(count, 1)),
      barnesHutOptimize: count > 1_000,
      barnesHutTheta: 0.5,
    };
  }

  step(iterations: number): void {
    if (this.nodes.length === 0) {
      return;
    }
    for (let i = 0; i < iterations; i++) {
      iterate(this.settings, this.nodes, this.edges);
    }
    this.done += iterations;
  }

  positions(): Float32Array {
    const count = this.nodes.length / PPN;
    const out = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      out[2 * i] = this.nodes[i * PPN] as number;
      out[2 * i + 1] = this.nodes[i * PPN + 1] as number;
    }
    return out;
  }
}

export interface HierarchyResult {
  positions: Float32Array;
  /** Edges that closed a cycle and were drawn against the direction to keep the layers. */
  reversed: number;
  layers: number;
}

/**
 * Distances in px at a zoom that shows the drawing at its natural size: the renderer draws node
 * sizes and labels in px, so a layer whose nodes stand at least their size and label apart has
 * no label over a neighbour whenever the drawing is shown at that size or larger.
 */
const LAYER_GAP = 80;
const NODE_GAP = 30;
/** Space between a label's end and the next node in the layer. */
const LABEL_GAP = 12;
const SWEEPS = 4;

/** Where a layer's nodes stand along it: each one its size and label away from the one before. */
function rowOffsets(row: readonly number[], graph: LayoutGraph): number[] {
  const out: number[] = [];
  let x = 0;
  row.forEach((node, i) => {
    if (i > 0) {
      const prev = row[i - 1] as number;
      const before = graph.sizes[prev] ?? 0;
      const label = graph.labels?.[prev] ?? 0;
      const own = graph.sizes[node] ?? 0;
      x += Math.max(NODE_GAP, before + (label > 0 ? label + LABEL_GAP : 0) + own + LABEL_GAP);
    }
    out.push(x);
  });
  // Centred on the node in the middle of the span, label included.
  const last = row.at(-1);
  const end = last === undefined ? 0 : (out.at(-1) ?? 0) + (graph.labels?.[last] ?? 0);
  return out.map((at) => at - end / 2);
}

/**
 * A layered layout for directed graphs (dependencies, org charts): edges point down. Cycles are
 * broken by reversing the edges a depth-first search finds going back, layers follow the
 * longest path from the roots, and a few barycenter sweeps order each layer to cut crossings.
 */
export function hierarchyLayout(graph: LayoutGraph): HierarchyResult {
  const { count, sources, targets } = graph;
  const out: number[][] = Array.from({ length: count }, () => []);
  for (let e = 0; e < sources.length; e++) {
    const s = sources[e] as number;
    const t = targets[e] as number;
    if (s !== t) (out[s] as number[]).push(t);
  }

  // Depth-first search without recursion; an edge to a node still on the stack goes back.
  const state = new Uint8Array(count); // 0 new, 1 on stack, 2 done
  const children: number[][] = Array.from({ length: count }, () => []);
  let reversed = 0;
  for (let root = 0; root < count; root++) {
    if (state[root] !== 0) continue;
    const stack: [node: number, next: number][] = [[root, 0]];
    state[root] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as [number, number];
      const [node, next] = top;
      const list = out[node] as number[];
      if (next >= list.length) {
        state[node] = 2;
        stack.pop();
        continue;
      }
      top[1] = next + 1;
      const child = list[next] as number;
      if (state[child] === 1) {
        reversed++;
        (children[child] as number[]).push(node);
      } else {
        (children[node] as number[]).push(child);
        if (state[child] === 0) {
          state[child] = 1;
          stack.push([child, 0]);
        }
      }
    }
  }

  // Longest-path layering in topological order (Kahn).
  const indegree = new Uint32Array(count);
  for (const list of children) for (const c of list) indegree[c] = (indegree[c] as number) + 1;
  const layer = new Int32Array(count);
  const queue: number[] = [];
  for (let i = 0; i < count; i++) if (indegree[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as number;
    for (const c of children[node] as number[]) {
      if ((layer[c] as number) < (layer[node] as number) + 1)
        layer[c] = (layer[node] as number) + 1;
      indegree[c] = (indegree[c] as number) - 1;
      if (indegree[c] === 0) queue.push(c);
    }
  }

  let layers = 0;
  for (let i = 0; i < count; i++) layers = Math.max(layers, (layer[i] as number) + 1);
  const rows: number[][] = Array.from({ length: layers }, () => []);
  for (const node of queue) (rows[layer[node] as number] as number[]).push(node);

  const parents: number[][] = Array.from({ length: count }, () => []);
  children.forEach((list, node) => {
    for (const c of list) (parents[c] as number[]).push(node);
  });
  const order = new Float64Array(count);
  const place = () =>
    rows.forEach((row) => {
      row.forEach((node, i) => {
        order[node] = i;
      });
    });
  place();
  const barycenter = (node: number, neighbours: number[]) => {
    if (neighbours.length === 0) return order[node] as number;
    let sum = 0;
    for (const n of neighbours) sum += order[n] as number;
    return sum / neighbours.length;
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    for (let k = 0; k < layers; k++) {
      const row = rows[down ? k : layers - 1 - k] as number[];
      const keys = new Map(
        row.map((node) => [node, barycenter(node, (down ? parents : children)[node] as number[])]),
      );
      row.sort((a, b) => (keys.get(a) as number) - (keys.get(b) as number) || a - b);
      row.forEach((node, i) => {
        order[node] = i;
      });
    }
  }

  const positions = new Float32Array(count * 2);
  for (const row of rows) {
    const offsets = rowOffsets(row, graph);
    row.forEach((node, i) => {
      positions[2 * node] = offsets[i] as number;
      // Graph coordinates grow upwards; the first layer goes on top.
      positions[2 * node + 1] = -(layer[node] as number) * LAYER_GAP;
    });
  }
  return { positions, reversed, layers };
}
