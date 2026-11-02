import { describe, expect, it } from "vitest";
import { LABEL_MARGIN } from "./labelCollisions";
import { ForceLayout, forceIterations, seedPositions } from "./layoutEngine";
import {
  drawingArea,
  MIN_NODE_SCALE,
  nodeScaleFor,
  pixelsPerUnit,
  SPREAD_LIMIT,
  type SpreadInput,
  STAGE_PADDING,
  spreadNodes,
} from "./spread";

/** Each node's box in px at the fitted framing: its shape and, when it counts, its label. */
function boxes(input: SpreadInput, positions: Float32Array, bbox: { x: number[]; y: number[] }) {
  const scale = pixelsPerUnit(
    { x: [bbox.x[0] ?? 0, bbox.x[1] ?? 1], y: [bbox.y[0] ?? 0, bbox.y[1] ?? 1] },
    input.width,
    input.height,
    STAGE_PADDING,
  );
  return [...input.radii].map((r, i) => {
    const x = (positions[2 * i] as number) * scale;
    const y = (positions[2 * i + 1] as number) * scale;
    const label = input.labels[i] as number;
    return {
      minX: x - r,
      maxX: label > 0 ? x + r + LABEL_MARGIN + label : x + r,
      minY: y - Math.max(r, label > 0 ? input.labelHeight / 2 : 0),
      maxY: y + Math.max(r, label > 0 ? input.labelHeight / 2 : 0),
    };
  });
}

function overlapping(list: ReturnType<typeof boxes>): number {
  let count = 0;
  list.forEach((a, i) => {
    list.forEach((b, j) => {
      if (j <= i) return;
      if (a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY) count++;
    });
  });
  return count;
}

/**
 * The power chain of the gallery's all-sources dashboard (gallery-datacenter.cypher) as the force
 * layout leaves it: grid and generator feed six UPS, each of them two PDUs, each PDU two racks.
 */
function powerChain(): SpreadInput {
  const names: string[] = ["Grid feed 20 kV", "Generator G1"];
  const edges: [number, number][] = [];
  const add = (name: string) => names.push(name) - 1;
  for (const hall of ["A", "B", "C"]) {
    const ups = [1, 2].map((n) => add(`UPS ${hall}${n}`));
    for (const u of ups) edges.push([0, u], [1, u]);
    for (const row of [1, 2]) {
      const racks = [1, 2].map((n) => add(`Rack ${hall}${row}-0${n}`));
      for (const [s, side] of ["A", "B"].entries()) {
        const pdu = add(`PDU ${hall}${row}-${side}`);
        edges.push([ups[s] as number, pdu]);
        for (const rack of racks) edges.push([pdu, rack]);
      }
    }
  }
  const count = names.length;
  const degree = new Float32Array(count);
  for (const [a, b] of edges) {
    degree[a] = (degree[a] as number) + 1;
    degree[b] = (degree[b] as number) + 1;
  }
  const radii = Float32Array.from(degree, (d) => 4 + d * 1.5);
  const layout = new ForceLayout(
    {
      count,
      sources: Uint32Array.from(edges, ([a]) => a),
      targets: Uint32Array.from(edges, ([, b]) => b),
      weights: new Float32Array(edges.length).fill(1),
      sizes: radii,
    },
    seedPositions(count),
  );
  layout.step(forceIterations(count));
  const order = [...radii.keys()].sort(
    (a, b) => (radii[b] as number) - (radii[a] as number) || a - b,
  );
  const ranks = new Int32Array(count);
  order.forEach((node, rank) => {
    ranks[node] = rank;
  });
  return {
    positions: layout.positions(),
    radii,
    labels: Float32Array.from(names, (name) => name.length * 7),
    ranks,
    labelHeight: 14,
    width: 800,
    height: 235,
  };
}

/** "UPS A1" and "UPS A2" as the force layout leaves them: almost on the same spot. */
function crowded(count: number, labelled: number): SpreadInput {
  const positions = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[2 * i] = (i % 6) * 0.4;
    positions[2 * i + 1] = Math.floor(i / 6) * 0.3;
  }
  // One far node, so the fitted drawing is small and the crowd lies on top of itself.
  positions[0] = -40;
  positions[1] = 25;
  return {
    positions,
    radii: new Float32Array(count).fill(6),
    labels: Float32Array.from({ length: count }, (_, i) => (i < labelled ? 44 : 0)),
    ranks: Int32Array.from({ length: count }, (_, i) => i),
    labelHeight: 14,
    width: 800,
    height: 240,
  };
}

describe("making room for nodes and labels in the panel", () => {
  it("pushes crowded nodes and their labels apart until no two overlap", () => {
    const input = crowded(24, 8);
    expect(overlapping(boxes(input, input.positions, { x: [-40, 2], y: [0, 25] }))).toBeGreaterThan(
      0,
    );
    const spread = spreadNodes(input);
    expect(spread.labelled).toBe(8);
    expect(overlapping(boxes({ ...input }, spread.positions, spread.bbox))).toBe(0);
  });

  it("keeps a short panel to the labels that fit its area, the best ranked first", () => {
    const input = { ...powerChain(), width: 560, height: 140 };
    const spread = spreadNodes(input);
    expect(spread.labelled).toBeGreaterThan(0);
    expect(spread.labelled).toBeLessThan(32);
    // The counted labels are the first by rank, and they and every node lie apart.
    const order = [...input.ranks.keys()].sort(
      (a, b) => (input.ranks[a] ?? 0) - (input.ranks[b] ?? 0),
    );
    const counted = new Set(order.slice(0, spread.labelled));
    const labels = Float32Array.from(input.labels, (w, i) => (counted.has(i) ? w : 0));
    const drawn = { ...input, labels, radii: input.radii.map((r) => r * spread.nodeScale) };
    expect(overlapping(boxes(drawn, spread.positions, spread.bbox))).toBe(0);
  });

  it("frames a box that reaches around the shapes and the labels to the right", () => {
    const input: SpreadInput = {
      positions: Float32Array.from([0, 0, 100, 0]),
      radii: Float32Array.from([5, 5]),
      labels: Float32Array.from([0, 60]),
      ranks: Int32Array.from([0, 1]),
      labelHeight: 14,
      width: 600,
      height: 300,
    };
    const { bbox, positions } = spreadNodes(input);
    expect([...positions]).toEqual([0, 0, 100, 0]);
    const scale = pixelsPerUnit(bbox, 600, 300, STAGE_PADDING);
    // Left: the first circle's edge; right: the end of the second node's label.
    expect(bbox.x[0] * scale).toBeCloseTo(-5, 1);
    expect((bbox.x[1] - 100) * scale).toBeGreaterThan(5 + LABEL_MARGIN + 60);
    // The drawing then fills the panel's drawing area, as wide as it is.
    expect((bbox.x[1] - bbox.x[0]) * scale).toBeCloseTo(drawingArea(600, 300).width, 0);
  });

  it("leaves the layers of a hierarchy and very large graphs where they are", () => {
    const input = crowded(24, 8);
    expect([...spreadNodes({ ...input, move: false }).positions]).toEqual([...input.positions]);
    const large = crowded(SPREAD_LIMIT + 1, 0);
    expect([...spreadNodes(large).positions]).toEqual([...large.positions]);
  });

  it("gives the power chain's labels room in the all-sources panel, UPS A1 beside UPS A2", () => {
    const input = powerChain();
    const spread = spreadNodes(input);
    expect(spread.nodeScale).toBe(1);
    expect(spread.labelled).toBeGreaterThanOrEqual(12);
    const order = [...input.ranks.keys()].sort(
      (a, b) => (input.ranks[a] ?? 0) - (input.ranks[b] ?? 0),
    );
    const counted = new Set(order.slice(0, spread.labelled));
    const labels = Float32Array.from(input.labels, (w, i) => (counted.has(i) ? w : 0));
    expect(overlapping(boxes({ ...input, labels }, spread.positions, spread.bbox))).toBe(0);
  });

  it("gives the same positions for the same input", () => {
    const input = crowded(30, 10);
    expect([...spreadNodes(input).positions]).toEqual([...spreadNodes(input).positions]);
  });
});

describe("node sizes in a short panel", () => {
  it("draws nodes smaller where they would fill the panel, never below a floor", () => {
    const radii = new Float32Array(32).fill(10);
    expect(nodeScaleFor(radii, 1200, 600)).toBe(1);
    const short = nodeScaleFor(radii, 420, 110);
    expect(short).toBeLessThan(1);
    expect(short).toBeGreaterThanOrEqual(MIN_NODE_SCALE);
    expect(nodeScaleFor(radii, 120, 40)).toBe(MIN_NODE_SCALE);
    // The spread draws the power chain at its scale in a short panel and keeps its nodes apart.
    for (const [width, height] of [
      [800, 235],
      [560, 140],
      [420, 95],
    ] as const) {
      const input = { ...powerChain(), labels: new Float32Array(32), width, height };
      const spread = spreadNodes(input);
      expect(spread.nodeScale).toBeCloseTo(nodeScaleFor(input.radii, width, height), 5);
      const drawn = { ...input, radii: input.radii.map((r) => r * spread.nodeScale) };
      expect(overlapping(boxes(drawn, spread.positions, spread.bbox))).toBe(0);
    }
  });
});

describe("the renderer's scale", () => {
  it("fits the wider side of a wide drawing into a wide panel, less the padding", () => {
    // 100 x 20 units into 800 x 200 px: the width limits (4:1 panel, 5:1 drawing).
    const scale = pixelsPerUnit({ x: [0, 100], y: [0, 20] }, 800, 200, 30);
    expect(100 * scale).toBeLessThanOrEqual(800);
    expect(20 * scale).toBeLessThanOrEqual(200 - 2 * 30);
    // A tall drawing in a wide panel: the height limits.
    const tall = pixelsPerUnit({ x: [0, 10], y: [0, 50] }, 800, 200, 30);
    expect(50 * tall).toBeCloseTo(200 - 2 * 30, 5);
  });
});
