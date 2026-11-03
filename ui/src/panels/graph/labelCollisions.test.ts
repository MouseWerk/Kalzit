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
    const clump = Array.from({ length: 6_000 }, (_, i) => node(i, 2 + (i % 2), 24, 2));
    const labelsAt = (minX: number) =>
      Array.from({ length: 400 }, (_, i) => ({
        index: 10_000 + i,
        box: { minX, maxX: 46, minY: 20 + (i % 4), maxY: 28 + (i % 4) },
        forced: false,
      }));
    let start = performance.now();
    expect(blockedLabels(clump, labelsAt(0)).size).toBe(400);
    expect(performance.now() - start).toBeLessThan(15);
    start = performance.now();
    const beside = blockedLabels(clump, labelsAt(30));
    expect(performance.now() - start).toBeLessThan(40);
    // At most MAX_TESTS / 6,000 labels were tested against the clump; the others wait.
    expect(beside.size).toBeGreaterThanOrEqual(400 - Math.ceil(MAX_TESTS / 6_000) - 1);
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
