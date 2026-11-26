import { describe, expect, it } from "vitest";
import { ForceLayout, forceIterations, hierarchyLayout, seedPositions } from "../layoutEngine";
import type { LayoutGuide, LayoutMode, LayoutRequest } from "../layoutProtocol";
import { circularLayout, MIN_CIRCLE_RADIUS } from "./circular";
import { coordinateLayout } from "./coordinates";
import { gridLayout } from "./grid";
import { placeLayout } from "./place";
import { bestConnected, RING_GAP, radialLayout } from "./radial";
import { seededRandom } from "./random";
import { NODE_GAP, STRIP_GAP } from "./shared";
import { timelineLayout } from "./timeline";

/**
 * The layouts of the layout menu (Graph081 board, frames 12 to 14) on flat arrays: where each
 * puts its nodes, that the same request always gives the same places, that pinned nodes stay,
 * and that nodes a layout cannot place stand in its strip.
 */

/** A request for `edges` between `count` nodes; sizes default to 6 px, labels to none. */
function request(
  mode: LayoutMode,
  count: number,
  edges: readonly (readonly [number, number])[] = [],
  patch: Partial<LayoutRequest> = {},
): LayoutRequest {
  return {
    type: "start",
    run: 1,
    mode,
    count,
    sources: Uint32Array.from(edges, ([s]) => s),
    targets: Uint32Array.from(edges, ([, t]) => t),
    weights: new Float32Array(edges.length).fill(1),
    sizes: new Float32Array(count).fill(6),
    labels: new Float32Array(count),
    start: seedPositions(count),
    ...patch,
  };
}

/** A star around node 0 with `leaves` leaves, each leaf with `tail` further nodes in a chain. */
function star(leaves: number, tail = 0): [number, number][] {
  const edges: [number, number][] = [];
  let next = leaves + 1;
  for (let leaf = 1; leaf <= leaves; leaf++) {
    edges.push([0, leaf]);
    let from = leaf;
    for (let i = 0; i < tail; i++) {
      edges.push([from, next]);
      from = next++;
    }
  }
  return edges;
}

/** A random graph from a seed: the same edges on every machine. */
function randomEdges(count: number, edges: number, seed: number): [number, number][] {
  const random = seededRandom(seed);
  return Array.from({ length: edges }, () => [
    Math.floor(random() * count),
    Math.floor(random() * count),
  ]);
}

const at = (positions: Float32Array, node: number) =>
  [positions[2 * node] as number, positions[2 * node + 1] as number] as const;
const distance = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The smallest room between two nodes' edges; negative when two overlap. */
function leastRoom(positions: Float32Array, sizes: Float32Array, nodes?: readonly number[]) {
  const list = nodes ?? Array.from(sizes, (_, i) => i);
  let least = Number.POSITIVE_INFINITY;
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const i = list[a] as number;
      const j = list[b] as number;
      const room =
        distance(at(positions, i), at(positions, j)) - (sizes[i] as number) - (sizes[j] as number);
      least = Math.min(least, room);
    }
  }
  return least;
}

function finite(positions: Float32Array): boolean {
  return positions.every((value) => Number.isFinite(value));
}

describe("seeded random", () => {
  it("gives the same numbers for the same seed, and others for another", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("radial layout with pinned nodes", () => {
  it("leaves a pinned node where it is and gives it no room in its sector", () => {
    const edges = star(4);
    const start = seedPositions(5);
    start[2 * 2] = 900;
    start[2 * 2 + 1] = -700;
    const fixed = new Uint8Array(5);
    fixed[2] = 1;
    const withPin = radialLayout(
      request("radial", 5, edges, { centers: Uint32Array.of(0), fixed, start }),
    );
    expect(at(withPin.positions, 2)).toEqual([900, -700]);
    const without = radialLayout(request("radial", 5, edges, { centers: Uint32Array.of(0) }));
    // Three nodes share the ring instead of four: neighbours stand a third of a turn apart
    // (with four, nodes 1 and 3 stand opposite each other).
    const turn = (r: { positions: Float32Array }) => {
      const [x1, y1] = at(r.positions, 1);
      const [x3, y3] = at(r.positions, 3);
      return Math.acos((x1 * x3 + y1 * y3) / (Math.hypot(x1, y1) * Math.hypot(x3, y3)));
    };
    expect(turn(withPin)).toBeCloseTo((2 * Math.PI) / 3, 2);
    expect(turn(without)).toBeCloseTo(Math.PI, 2);
  });
});

describe("radial layout", () => {
  it("puts the chosen node in the middle and each ring one step further out", () => {
    const edges = star(5, 2);
    const result = radialLayout(request("radial", 16, edges, { centers: Uint32Array.of(0) }));
    expect(result.centers).toEqual([0]);
    expect(at(result.positions, 0)).toEqual([0, 0]);
    // Ring 1: the leaves; rings 2 and 3: their chains.
    expect([...result.rings.slice(0, 6)]).toEqual([0, 1, 1, 1, 1, 1]);
    expect(Math.max(...result.rings)).toBe(3);
    for (let node = 0; node < 16; node++) {
      const ring = result.rings[node] as number;
      expect(distance(at(result.positions, node), [0, 0])).toBeCloseTo(
        result.radii[ring] as number,
        3,
      );
    }
    for (let ring = 1; ring < result.radii.length; ring++) {
      expect(
        (result.radii[ring] as number) - (result.radii[ring - 1] as number),
      ).toBeGreaterThanOrEqual(RING_GAP);
    }
    expect(result.guides.map((guide) => guide.kind)).toEqual(["ring", "ring", "ring"]);
  });

  it("keeps a node's descendants in its own sector", () => {
    const result = radialLayout(request("radial", 16, star(5, 2), { centers: Uint32Array.of(0) }));
    const angle = (node: number) =>
      Math.atan2(...(at(result.positions, node).toReversed() as [number, number]));
    // Leaf k and the two nodes of its chain (6 + 2(k-1), 7 + 2(k-1)) share one direction.
    for (let leaf = 1; leaf <= 5; leaf++) {
      const first = 6 + 2 * (leaf - 1);
      expect(angle(first)).toBeCloseTo(angle(leaf), 6);
      expect(angle(first + 1)).toBeCloseTo(angle(leaf), 6);
    }
  });

  it("falls back to the best connected node when nothing is selected", () => {
    // Node 3 has the most edges; nodes 0 and 1 tie below it.
    const edges: [number, number][] = [
      [3, 0],
      [3, 1],
      [3, 2],
      [0, 1],
    ];
    expect(bestConnected(request("radial", 4, edges))).toBe(3);
    const result = radialLayout(request("radial", 4, edges));
    expect(result.centers).toEqual([3]);
    expect(at(result.positions, 3)).toEqual([0, 0]);
    // A tie goes to the first node, so the same data always has the same middle.
    expect(
      bestConnected(
        request("radial", 3, [
          [0, 1],
          [1, 2],
          [2, 0],
        ]),
      ),
    ).toBe(0);
    // An empty selection is no selection.
    expect(
      radialLayout(request("radial", 4, edges, { centers: new Uint32Array(0) })).centers,
    ).toEqual([3]);
  });

  it("lets several chosen nodes share the middle on a ring of their own", () => {
    const edges: [number, number][] = [
      [0, 2],
      [0, 3],
      [1, 4],
    ];
    const result = radialLayout(request("radial", 5, edges, { centers: Uint32Array.of(0, 1) }));
    expect(result.centers).toEqual([0, 1]);
    expect([...result.rings]).toEqual([0, 0, 1, 1, 1]);
    const inner = result.radii[0] as number;
    expect(inner).toBeGreaterThan(0);
    expect(distance(at(result.positions, 0), [0, 0])).toBeCloseTo(inner, 4);
    expect(distance(at(result.positions, 1), [0, 0])).toBeCloseTo(inner, 4);
    expect(leastRoom(result.positions, new Float32Array(5).fill(6))).toBeGreaterThan(0);
  });

  it("puts what is not connected on an outer ring", () => {
    // 0-1-2 are connected; 3, 4 and 5 have no path to the middle.
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
      [3, 4],
    ];
    const result = radialLayout(request("radial", 6, edges, { centers: Uint32Array.of(0) }));
    expect([...result.rings]).toEqual([0, 1, 2, -1, -1, -1]);
    const outer = result.radii.at(-1) as number;
    expect(outer).toBeGreaterThanOrEqual((result.radii[2] as number) + RING_GAP);
    for (const node of [3, 4, 5]) {
      expect(distance(at(result.positions, node), [0, 0])).toBeCloseTo(outer, 3);
    }
  });

  it("leaves no two nodes on one place, whatever their sizes", () => {
    const count = 300;
    const sizes = Float32Array.from({ length: count }, (_, i) => 4 + (i % 7) * 5);
    const result = radialLayout(
      request("radial", count, randomEdges(count, 420, 11), { sizes, centers: Uint32Array.of(5) }),
    );
    expect(finite(result.positions)).toBe(true);
    expect(leastRoom(result.positions, sizes)).toBeGreaterThanOrEqual(0);
  });

  it("ignores loops, repeated edges and centres that do not exist", () => {
    const edges: [number, number][] = [
      [0, 0],
      [0, 1],
      [0, 1],
      [1, 0],
    ];
    const result = radialLayout(request("radial", 2, edges, { centers: Uint32Array.of(9, 1, 1) }));
    expect(result.centers).toEqual([1]);
    expect([...result.rings]).toEqual([1, 0]);
    expect(radialLayout(request("radial", 0)).positions).toHaveLength(0);
  });

  it("ignores centres below zero or between two nodes", () => {
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
    ];
    // A typed array cannot hold them; a request built by hand can.
    const centers = [-1, 0.5, 2] as unknown as Uint32Array;
    const result = radialLayout(request("radial", 3, edges, { centers }));
    expect(result.centers).toEqual([2]);
    expect([...result.rings]).toEqual([2, 1, 0]);
    expect(finite(result.positions)).toBe(true);
  });
});

describe("circular layout", () => {
  it("puts every node on one circle, clockwise from the top in the given order", () => {
    const order = Uint32Array.of(3, 1, 4, 0, 2, 5);
    const result = circularLayout(request("circular", 6, [], { order }));
    expect(result.radius).toBeGreaterThanOrEqual(MIN_CIRCLE_RADIUS);
    for (let node = 0; node < 6; node++) {
      expect(distance(at(result.positions, node), [0, 0])).toBeCloseTo(result.radius, 3);
    }
    // Clockwise from the top: the angle from "up" grows along the order.
    const turn = (node: number) => {
      const [x, y] = at(result.positions, node);
      return (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
    };
    const turns = [...order].map(turn);
    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    expect(result.guides).toEqual([{ kind: "ring", x: 0, y: 0, radius: result.radius }]);
  });

  it("gives large nodes the room they need", () => {
    for (const sizes of [
      Float32Array.of(40, 40),
      Float32Array.of(40, 4, 40),
      Float32Array.from({ length: 200 }, (_, i) => 2 + (i % 5) * 9),
    ]) {
      const result = circularLayout(request("circular", sizes.length, [], { sizes }));
      expect(leastRoom(result.positions, sizes)).toBeGreaterThanOrEqual(0);
    }
  });

  it("places one node in the middle and none at all without nodes", () => {
    expect([...circularLayout(request("circular", 1)).positions]).toEqual([0, 0]);
    expect(circularLayout(request("circular", 0)).positions).toHaveLength(0);
  });

  it("places nodes the order leaves out, after the others", () => {
    const result = circularLayout(request("circular", 4, [], { order: Uint32Array.of(2, 2, 9) }));
    expect(finite(result.positions)).toBe(true);
    expect(leastRoom(result.positions, new Float32Array(4).fill(6))).toBeGreaterThan(0);
    // Node 2 comes first: straight up from the middle, half its arc to the right.
    expect(at(result.positions, 2)[1]).toBeGreaterThan(0);
  });
});

describe("grid layout", () => {
  it("fills rows from the top left in the given order", () => {
    const order = Uint32Array.from({ length: 12 }, (_, i) => 11 - i);
    const result = gridLayout(request("grid", 12, [], { order }));
    expect(result.columns * result.rows).toBeGreaterThanOrEqual(12);
    expect(result.columns).toBeGreaterThanOrEqual(result.rows);
    [...order].forEach((node, i) => {
      const [x, y] = at(result.positions, node);
      const first = at(result.positions, order[0] as number);
      expect(x - first[0]).toBeCloseTo((i % result.columns) * result.cell.width, 3);
      expect(first[1] - y).toBeCloseTo(Math.floor(i / result.columns) * result.cell.height, 3);
    });
  });

  it("keeps nodes and an average label apart", () => {
    const sizes = Float32Array.from({ length: 50 }, (_, i) => 4 + (i % 4) * 6);
    const labels = new Float32Array(50).fill(80);
    const result = gridLayout(request("grid", 50, [], { sizes, labels }));
    expect(leastRoom(result.positions, sizes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01);
    expect(result.cell.width).toBeGreaterThanOrEqual(2 * 22 + 80);
    // Without labels a cell is as wide as it is tall.
    const bare = gridLayout(request("grid", 50, [], { sizes }));
    expect(bare.cell.width).toBe(bare.cell.height);
  });

  it("is centred on the origin", () => {
    const { positions } = gridLayout(request("grid", 9));
    const xs = Array.from({ length: 9 }, (_, i) => at(positions, i)[0]);
    const ys = Array.from({ length: 9 }, (_, i) => at(positions, i)[1]);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 3);
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(0, 3);
  });
});

describe("coordinate layout", () => {
  const NONE = Number.NaN;

  it("puts each node where its two values say, x to the right and y upwards", () => {
    const values = Float64Array.of(0, 0, 10, 0, 0, 100, 10, 100, 5, 50);
    const result = coordinateLayout(request("coordinates", 5, [], { values }));
    expect(result.placed).toBe(5);
    expect(result.unplaced).toBe(0);
    // Each axis fills its side on its own scale.
    expect(at(result.positions, 0)).toEqual([0, 0]);
    expect(at(result.positions, 1)).toEqual([result.side, 0]);
    expect(at(result.positions, 2)).toEqual([0, result.side]);
    expect(at(result.positions, 4)).toEqual([result.side / 2, result.side / 2]);
    expect(result.range).toEqual({ x: [0, 10], y: [0, 100] });
    expect(result.guides.map((guide) => guide.kind)).toEqual(["axis", "axis"]);
  });

  it("keeps distances true on one shared scale for a point", () => {
    const values = Float64Array.of(0, 0, 10, 0, 0, 100);
    const result = coordinateLayout(request("coordinates", 3, [], { values, uniform: true }));
    const a = distance(at(result.positions, 0), at(result.positions, 1));
    const b = distance(at(result.positions, 0), at(result.positions, 2));
    expect(b / a).toBeCloseTo(10, 4);
    const axes = result.guides.filter((guide) => guide.kind === "axis");
    // Both axes span the same range: the larger one.
    expect(axes.map((axis) => axis.max - axis.min)).toEqual([100, 100]);
  });

  it("puts nodes without both values into a strip beside the square, with their number", () => {
    const values = Float64Array.of(1, 1, NONE, 2, 3, NONE, 4, 4, NONE, NONE);
    const result = coordinateLayout(request("coordinates", 5, [], { values }));
    expect(result.placed).toBe(2);
    expect(result.unplaced).toBe(3);
    const strip = result.guides.find((guide) => guide.kind === "strip");
    expect(strip).toMatchObject({ count: 3, reason: "noValue" });
    for (const node of [1, 2, 4]) {
      const [x, y] = at(result.positions, node);
      expect(x).toBeGreaterThanOrEqual(result.side + STRIP_GAP);
      expect(y).toBeLessThanOrEqual(result.side);
    }
    expect(leastRoom(result.positions, new Float32Array(5).fill(6), [1, 2, 4])).toBeGreaterThan(0);
  });

  it("stands a single value, or all on one line, in the middle of its axis", () => {
    const one = coordinateLayout(request("coordinates", 1, [], { values: Float64Array.of(7, 9) }));
    expect(at(one.positions, 0)).toEqual([one.side / 2, one.side / 2]);
    const line = coordinateLayout(
      request("coordinates", 2, [], { values: Float64Array.of(1, 5, 3, 5) }),
    );
    expect(at(line.positions, 0)).toEqual([0, line.side / 2]);
    expect(at(line.positions, 1)).toEqual([line.side, line.side / 2]);
  });

  it("puts every node into the strip when none has values", () => {
    const result = coordinateLayout(request("coordinates", 30));
    expect(result.placed).toBe(0);
    expect(result.unplaced).toBe(30);
    expect(result.range).toBeNull();
    expect(result.guides.map((guide) => guide.kind)).toEqual(["strip"]);
    expect(finite(result.positions)).toBe(true);
    expect(leastRoom(result.positions, new Float32Array(30).fill(6))).toBeGreaterThan(0);
  });
});

describe("timeline layout", () => {
  const DAY = 86_400_000;
  const NONE = Number.NaN;

  it("orders nodes by time from left to right, each label in a lane of its own", () => {
    const times = Float64Array.of(3 * DAY, 1 * DAY, 2 * DAY, 10 * DAY, 5 * DAY);
    const lanes = Int32Array.of(0, 0, 1, 1, 0);
    const result = timelineLayout(request("timeline", 5, [], { times, lanes }));
    expect(result.placed).toBe(5);
    expect(result.range).toEqual([1 * DAY, 10 * DAY]);
    const x = (node: number) => at(result.positions, node)[0];
    const y = (node: number) => at(result.positions, node)[1];
    expect([1, 2, 0, 4, 3].map(x)).toEqual([1, 2, 0, 4, 3].map(x).sort((a, b) => a - b));
    expect(x(1)).toBe(0);
    expect(x(3)).toBe(result.width);
    // Lane 0 above lane 1.
    expect(result.lanes.map((lane) => lane.lane)).toEqual([0, 1]);
    for (const upper of [0, 1, 4]) {
      for (const lower of [2, 3]) expect(y(upper)).toBeGreaterThan(y(lower));
    }
    expect(result.guides.map((guide) => guide.kind)).toEqual(["axis", "lane", "lane"]);
  });

  it("gives nodes at the same time rows of their own, so none covers another", () => {
    const count = 40;
    const times = Float64Array.from({ length: count }, (_, i) => (i % 4) * DAY);
    const sizes = new Float32Array(count).fill(8);
    const result = timelineLayout(request("timeline", count, [], { times, sizes }));
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.rows).toBe(10);
    expect(leastRoom(result.positions, sizes)).toBeGreaterThanOrEqual(NODE_GAP - 0.01);
  });

  it("puts nodes without a time into a strip at the end, with their number", () => {
    const times = Float64Array.of(1 * DAY, NONE, 4 * DAY, NONE);
    const result = timelineLayout(request("timeline", 4, [], { times }));
    expect(result.placed).toBe(2);
    expect(result.unplaced).toBe(2);
    expect(result.guides.at(-1)).toMatchObject({ kind: "strip", count: 2, reason: "noTime" });
    for (const node of [1, 3]) {
      expect(at(result.positions, node)[0]).toBeGreaterThanOrEqual(result.width + STRIP_GAP);
    }
  });

  it("gives pinned nodes no row, so the others leave no gap for them", () => {
    const count = 6;
    const times = new Float64Array(count).fill(1 * DAY);
    times[count - 1] = 2 * DAY;
    const fixed = Uint8Array.of(1, 1, 0, 0, 0, 0);
    const start = seedPositions(count);
    start[0] = 900;
    start[1] = 900;
    start[2] = -900;
    start[3] = -900;
    const result = timelineLayout(request("timeline", count, [], { times, fixed, start }));
    const bare = timelineLayout(request("timeline", count - 2, [], { times: times.slice(2) }));
    // The pinned nodes stay where they were.
    expect(at(result.positions, 0)).toEqual([900, 900]);
    expect(at(result.positions, 1)).toEqual([-900, -900]);
    // The free nodes fill the rows from the top, as if the pinned ones were not there.
    expect(result.lanes).toEqual(bare.lanes);
    expect(result.lanes[0]?.rows).toBe(3);
    const ys = [2, 3, 4].map((node) => at(result.positions, node)[1]).sort((a, b) => b - a);
    const bareYs = [0, 1, 2].map((node) => at(bare.positions, node)[1]).sort((a, b) => b - a);
    expect(ys).toEqual(bareYs);
    // Their time still counts for the axis.
    expect(result.placed).toBe(count);
    expect(result.range).toEqual([1 * DAY, 2 * DAY]);
  });

  it("stays fast when thousands of nodes share one time", () => {
    const count = 20_000;
    const started = performance.now();
    const result = timelineLayout(
      request("timeline", count, [], { times: new Float64Array(count) }),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.lanes[0]?.rows).toBe(count);
    expect(finite(result.positions)).toBe(true);
  });
});

describe("hierarchy layout", () => {
  const chain: [number, number][] = [
    [0, 1],
    [1, 2],
    [0, 3],
  ];

  it("points its layers down, right, up or left", () => {
    const base = request("hierarchy", 4, chain);
    const depth = (direction: "down" | "right" | "up" | "left") => {
      const { positions } = hierarchyLayout(base, { direction });
      const axis = direction === "down" || direction === "up" ? 1 : 0;
      const sign = direction === "down" || direction === "left" ? -1 : 1;
      return [0, 1, 2].map((node) => sign * (at(positions, node)[axis] as number));
    };
    for (const direction of ["down", "right", "up", "left"] as const) {
      const [root, child, grandchild] = depth(direction) as [number, number, number];
      expect(child).toBeGreaterThan(root);
      expect(grandchild).toBeGreaterThan(child);
    }
    // The default is down, as before.
    expect([...hierarchyLayout(base).positions]).toEqual([
      ...hierarchyLayout(base, { direction: "down" }).positions,
    ]);
  });

  it("stands layers side by side a label's width further apart", () => {
    const labels = new Float32Array(4).fill(120);
    const down = hierarchyLayout(request("hierarchy", 4, chain, { labels }), { direction: "down" });
    const right = hierarchyLayout(request("hierarchy", 4, chain, { labels }), {
      direction: "right",
    });
    const step = (positions: Float32Array, axis: 0 | 1) =>
      Math.abs((at(positions, 1)[axis] as number) - (at(positions, 0)[axis] as number));
    expect(step(right.positions, 0)).toBe(step(down.positions, 1) + 120);
  });

  it("says how far it is, up to all nodes", () => {
    const count = 500;
    const said: number[] = [];
    hierarchyLayout(request("hierarchy", count, randomEdges(count, 900, 3)), {
      work: (done, total) => {
        expect(total).toBe(count);
        said.push(done);
      },
    });
    expect(said.length).toBeGreaterThan(3);
    expect(said).toEqual([...said].sort((a, b) => a - b));
    expect(said.at(-1)).toBe(count);
  });
});

describe("every layout", () => {
  const count = 120;
  const edges = randomEdges(count, 200, 21);
  const DAY = 86_400_000;
  const inputs: Partial<LayoutRequest> = {
    centers: Uint32Array.of(4, 9),
    order: Uint32Array.from({ length: count }, (_, i) => count - 1 - i),
    values: Float64Array.from({ length: count * 2 }, (_, i) => (i % 9 === 0 ? Number.NaN : i * 3)),
    times: Float64Array.from({ length: count }, (_, i) => (i % 6 === 0 ? Number.NaN : i * DAY)),
    lanes: Int32Array.from({ length: count }, (_, i) => i % 3),
  };
  const MODES = ["hierarchy", "radial", "circular", "grid", "coordinates", "timeline"] as const;

  it.each(MODES)("places every node of a %s at a finite place", (mode) => {
    const result = placeLayout(request(mode, count, edges, inputs));
    expect(result.positions).toHaveLength(count * 2);
    expect(finite(result.positions)).toBe(true);
  });

  it.each(MODES)("gives the same %s for the same request", (mode) => {
    const first = placeLayout(request(mode, count, edges, inputs));
    const second = placeLayout(request(mode, count, edges, inputs));
    expect([...second.positions]).toEqual([...first.positions]);
    expect(second.guides).toEqual(first.guides);
    expect(second.reversed).toBe(first.reversed);
  });

  it.each(MODES)("leaves pinned nodes of a %s where they are", (mode) => {
    const fixed = new Uint8Array(count);
    const start = seedPositions(count);
    const pinned = [0, 7, 54, 119];
    pinned.forEach((node, i) => {
      fixed[node] = 1;
      start[2 * node] = 1_000 + i * 37;
      start[2 * node + 1] = -2_000 - i * 11;
    });
    const result = placeLayout(request(mode, count, edges, { ...inputs, fixed, start }));
    pinned.forEach((node, i) => {
      expect(at(result.positions, node)).toEqual([1_000 + i * 37, -2_000 - i * 11]);
    });
    // The others are arranged, not left at their start.
    const moved = Array.from({ length: count }, (_, node) => node).filter(
      (node) => fixed[node] === 0 && distance(at(result.positions, node), at(start, node)) > 1e-3,
    );
    expect(moved.length).toBeGreaterThan(count / 2);
  });

  it("gives a pinned node no place of its own on a circle or in a grid", () => {
    const fixed = Uint8Array.of(0, 1, 0, 0, 0);
    const free = [0, 2, 3, 4];
    const circle = circularLayout(request("circular", 5, [], { fixed }));
    for (const node of free) {
      expect(distance(at(circle.positions, node), [0, 0])).toBeCloseTo(circle.radius, 3);
    }
    const four = circularLayout(request("circular", 4));
    expect(circle.radius).toBeCloseTo(four.radius, 4);
    // The grid is the one of the four free nodes: the pinned one takes no cell.
    const grid = gridLayout(request("grid", 5, [], { fixed }));
    const bare = gridLayout(request("grid", 4));
    expect([grid.columns, grid.rows]).toEqual([bare.columns, bare.rows]);
    free.forEach((node, i) => {
      expect(at(grid.positions, node)).toEqual(at(bare.positions, i));
    });
  });

  it("has no strip for pinned nodes without a value or a time", () => {
    const fixed = Uint8Array.of(1, 0);
    const none = Float64Array.of(Number.NaN, Number.NaN, 1, 1);
    const coordinates = coordinateLayout(request("coordinates", 2, [], { fixed, values: none }));
    expect(coordinates.unplaced).toBe(0);
    expect(coordinates.guides.some((guide: LayoutGuide) => guide.kind === "strip")).toBe(false);
    const timeline = timelineLayout(
      request("timeline", 2, [], { fixed, times: Float64Array.of(Number.NaN, 5) }),
    );
    expect(timeline.unplaced).toBe(0);
  });

  it("refuses to place the force layout in one piece", () => {
    expect(() => placeLayout(request("force", 3))).toThrow();
  });
});

describe("force layout", () => {
  const count = 60;
  const edges = randomEdges(count, 90, 5);

  function settle(patch: Partial<LayoutRequest> = {}): Float32Array {
    const input = request("force", count, edges, patch);
    const layout = new ForceLayout(input, input.start);
    layout.step(forceIterations(count));
    return layout.positions();
  }

  it("settles the same way for the same seed and another way for another", () => {
    const first = settle();
    expect([...settle()]).toEqual([...first]);
    const other = settle({ start: seedPositions(count, undefined, 1) });
    expect([...settle({ start: seedPositions(count, undefined, 1) })]).toEqual([...other]);
    expect([...other]).not.toEqual([...first]);
    // Seed 0 is the start the panel always had.
    expect([...seedPositions(count, undefined, 0)]).toEqual([...seedPositions(count)]);
  });

  it("keeps pinned nodes where they are while the others settle around them", () => {
    const fixed = new Uint8Array(count);
    const start = seedPositions(count);
    fixed[3] = 1;
    fixed[40] = 1;
    start.set([500, 500], 6);
    start.set([-300, 120], 80);
    const positions = settle({ fixed, start });
    expect(at(positions, 3)).toEqual([500, 500]);
    expect(at(positions, 40)).toEqual([-300, 120]);
    expect(distance(at(positions, 0), at(start, 0))).toBeGreaterThan(1);
  });
});
