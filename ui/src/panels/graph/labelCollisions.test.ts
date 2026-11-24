import { describe, expect, it } from "vitest";
import {
  blockedLabels,
  type DrawnNode,
  LABEL_MARGIN,
  labelBox,
  MAX_TESTS,
  nodeHitsBox,
  type WantedLabel,
} from "./labelCollisions";
import { LABEL_BUDGET, labelBudgetFor } from "./view";

function node(index: number, x: number, y: number, radius = 6): DrawnNode {
  return { index, x, y, radius };
}

function label(n: DrawnNode, width = 48, forced = false): WantedLabel {
  return { index: n.index, box: labelBox(n, width, 14), forced };
}

/**
 * Runs `work` and counts the steps that gather elements: each step of an array iterator (for-of
 * and spread), each element pushed, each Set or Map entry added, and each element that slice,
 * concat, filter or map go through. Deterministic, unlike a time; restored afterwards.
 */
function countCollecting<T>(work: () => T): { result: T; steps: number } {
  let steps = 0;
  const arrays = Array.prototype;
  const iterator = Object.getPrototypeOf([][Symbol.iterator]()) as { next: () => unknown };
  const saved = {
    next: iterator.next,
    push: arrays.push,
    slice: arrays.slice,
    concat: arrays.concat,
    filter: arrays.filter,
    map: arrays.map,
    add: Set.prototype.add,
    set: Map.prototype.set,
  };
  try {
    iterator.next = function (this: unknown) {
      steps++;
      return saved.next.call(this);
    };
    arrays.push = function (this: unknown[], ...items: unknown[]) {
      steps += items.length;
      return saved.push.apply(this, items);
    };
    arrays.slice = function (this: unknown[], start?: number, end?: number) {
      const out = saved.slice.call(this, start, end);
      steps += out.length;
      return out;
    };
    arrays.concat = function (this: unknown[], ...items: unknown[]) {
      const out = saved.concat.apply(this, items);
      steps += out.length;
      return out;
    };
    arrays.filter = function (this: unknown[], ...args: Parameters<typeof saved.filter>) {
      steps += this.length;
      return saved.filter.apply(this, args);
    } as typeof saved.filter;
    arrays.map = function (this: unknown[], ...args: Parameters<typeof saved.map>) {
      steps += this.length;
      return saved.map.apply(this, args);
    } as typeof saved.map;
    Set.prototype.add = function (this: Set<unknown>, value: unknown) {
      steps++;
      return saved.add.call(this, value);
    };
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      steps++;
      return saved.set.call(this, key, value);
    };
    return { result: work(), steps };
  } finally {
    iterator.next = saved.next;
    arrays.push = saved.push;
    arrays.slice = saved.slice;
    arrays.concat = saved.concat;
    arrays.filter = saved.filter;
    arrays.map = saved.map;
    Set.prototype.add = saved.add;
    Map.prototype.set = saved.set;
  }
}

/**
 * Steps the clump walk below may take: it measured 14,404 (6,000 for the grid, the rest for
 * the labels); gathering the clump per label adds 2,400,000.
 */
const STEPS_BOUND = 20_000;

describe("label collisions", () => {
  it("leaves out a label that would run over the next node's circle", () => {
    // "UPS A1" and "UPS A2" side by side: A1's label reaches A2's circle.
    const a1 = node(0, 100, 100);
    const a2 = node(1, 140, 100);
    const blocked = blockedLabels([a1, a2], [label(a1), label(a2)]);
    expect([...blocked]).toEqual([0]);
  });

  it("keeps labels that have room, and the node's own circle never blocks its label", () => {
    const a = node(0, 100, 100);
    const b = node(1, 100, 160);
    expect(blockedLabels([a, b], [label(a), label(b)]).size).toBe(0);
  });

  it("places the better ranked label first; a later one covering it is left out", () => {
    // Stacked closely: the second label's box overlaps the first's, not its circle.
    const a = node(0, 100, 100);
    const b = node(1, 100, 110, 3);
    const blocked = blockedLabels([a, b], [label(a), label(b)]);
    expect([...blocked]).toEqual([1]);
  });

  it("always places a forced label (a selected node) and lets it block others", () => {
    const a = node(0, 100, 100);
    const b = node(1, 100 + 6 + LABEL_MARGIN + 10, 100);
    const blocked = blockedLabels([a, b], [label(a), label(b, 48, true)]);
    expect([...blocked]).toEqual([0]);
  });

  it("leaves out a label that would run out of the panel, unless it is forced", () => {
    const a = node(0, 380, 100);
    const panel = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
    expect([...blockedLabels([a], [label(a)], panel)]).toEqual([0]);
    expect(blockedLabels([a], [label(a, 48, true)], panel).size).toBe(0);
  });

  it("bounds the work where nodes clump into one spot: labels beyond the budget wait", () => {
    // Two thousand nodes on one spot, and labels far from them: placing each label would test
    // it against every node of the clump's cell.
    const clump = Array.from({ length: 2_000 }, (_, i) => node(i, 10 + (i % 3), 10, 3));
    const far = Array.from({ length: 50 }, (_, i) => node(5_000 + i, 15, 10 + 20 * i, 3));
    const labels = [...far].map((n) => label(n, 20));
    const blocked = blockedLabels([...clump, ...far], labels, undefined, 3_000);
    // The first labels were tested; once the budget is spent the rest are left out.
    expect(blocked.size).toBeGreaterThan(0);
    expect(blocked.has(5_049)).toBe(true);
    // A forced label is placed whatever the budget.
    const forced = blockedLabels(clump, [label(node(9_999, 400, 400), 20, true)], undefined, 0);
    expect(forced.size).toBe(0);
  });

  it("walks a clump without collecting it, and counts every visit towards the budget", () => {
    // 6,000 nodes in one grid cell and 400 labels in that cell. Over the clump, a label is left
    // out at its first node, without gathering the whole clump first; beside it, each label
    // would visit the whole clump, and the cap of MAX_TESTS visits holds the work.
    // The work is counted, not timed: a node is visited when its index is read, which only the
    // test against a label does. A bound in milliseconds failed whenever the machine was busy
    // (16 ms against 15 on a Windows runner, 51 against 40 with other builds running).
    // Visits equal the budget's tests only while that test reads a node's index exactly once.
    let visits = 0;
    const clump = Array.from({ length: 6_000 }, (_, i) => {
      const drawn = node(i, 2 + (i % 2), 24, 2);
      return {
        ...drawn,
        get index() {
          visits++;
          return drawn.index;
        },
      };
    });
    const labelsAt = (minX: number) =>
      Array.from({ length: 400 }, (_, i) => ({
        index: 10_000 + i,
        box: { minX, maxX: 46, minY: 20 + (i % 4), maxY: 28 + (i % 4) },
        forced: false,
      }));
    const over = labelsAt(0);
    const { result, steps } = countCollecting(() => blockedLabels(clump, over));
    expect(result.size).toBe(400);
    // One visit per label: each stops at the first node it meets.
    expect(visits).toBe(400);
    // Collecting is what the visits cannot see: gathering the clump's cell before testing costs
    // 6,000 steps per label (2,400,000 here) without reading a node. Building the grid takes
    // 6,000 steps and placing the labels a few thousand; the walk adds one per label.
    expect(steps).toBeGreaterThanOrEqual(6_000);
    expect(steps).toBeLessThan(STEPS_BOUND);
    visits = 0;
    const beside = blockedLabels(clump, labelsAt(30));
    // Each label beside the clump visits all 6,000 nodes until the budget is spent, exactly:
    // the first label is placed, and each of the next 32 (all of whose node visits fit the budget)
    // also visits that placed label once, which the budget counts too.
    expect(visits).toBe(MAX_TESTS - 32);
    // At most MAX_TESTS / 6,000 labels were tested against the clump; the others wait.
    expect(beside.size).toBeGreaterThanOrEqual(400 - Math.ceil(MAX_TESTS / 6_000) - 1);
  });

  it("counts a collecting walk, so the clump test would catch one", () => {
    // The guard above against gathering a clump first, checked against such a gathering: one
    // Set of the cell per label, the way the walk worked before it stopped collecting.
    const cell = Array.from({ length: 6_000 }, (_, i) => i);
    const { steps } = countCollecting(() => {
      let found = 0;
      for (let label = 0; label < 400; label++) {
        const gathered = new Set<number>();
        for (const item of cell) gathered.add(item);
        found += gathered.size;
      }
      return found;
    });
    expect(steps).toBeGreaterThan(400 * 6_000);
  });

  it("tests a label against the shape a node is drawn with", () => {
    // A box just off the corner of a node of radius 10 at the origin.
    const corner = { minX: 8, maxX: 20, minY: 8, maxY: 20 };
    expect(nodeHitsBox({ index: 0, x: 0, y: 0, radius: 10, shape: "circle" }, corner)).toBe(false);
    expect(nodeHitsBox({ index: 0, x: 0, y: 0, radius: 10, shape: "square" }, corner)).toBe(true);
    expect(nodeHitsBox({ index: 0, x: 0, y: 0, radius: 10, shape: "diamond" }, corner)).toBe(false);
    // Straight to the right, all three reach it.
    const side = { minX: 9, maxX: 20, minY: -2, maxY: 2 };
    for (const shape of ["circle", "square", "diamond"] as const) {
      expect(nodeHitsBox({ index: 0, x: 0, y: 0, radius: 10, shape }, side)).toBe(true);
    }
  });
});

describe("label budget by panel size", () => {
  it("gives a large panel the full budget and a short one fewer labels, never below a floor", () => {
    expect(labelBudgetFor(1600, 800)).toBe(LABEL_BUDGET);
    const short = labelBudgetFor(500, 220);
    expect(short).toBeLessThan(LABEL_BUDGET);
    expect(short).toBeGreaterThan(0);
    expect(labelBudgetFor(100, 50)).toBe(6);
    expect(labelBudgetFor(0, 0)).toBe(LABEL_BUDGET);
  });
});
