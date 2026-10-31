import { describe, expect, it } from "vitest";
import { blockedLabels, type DrawnNode, LABEL_MARGIN, sameSet } from "./labelCollisions";
import { LABEL_BUDGET, labelBudgetFor } from "./view";

function node(index: number, x: number, y: number, radius = 6): DrawnNode {
  return { index, x, y, radius };
}

function label(n: DrawnNode, width = 48, forced = false) {
  return { ...n, width, height: 14, forced };
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

  it("compares sets", () => {
    expect(sameSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameSet(new Set([1]), new Set([2]))).toBe(false);
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
