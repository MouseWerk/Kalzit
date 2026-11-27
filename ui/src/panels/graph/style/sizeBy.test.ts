import { describe, expect, it } from "vitest";
import { evaluateRules } from "./evaluate";
import { withResultRule } from "./fromResult";
import { EMPTY_STYLE, type NodeRule, parseGraphStyle } from "./schema";

const items = [
  { kinds: ["Kunde"], properties: { pagerank: 0.1 } },
  { kinds: ["Kunde"], properties: { pagerank: 0.4 } },
  { kinds: ["Kunde"], properties: { pagerank: 0.25 } },
  { kinds: ["Kunde"], properties: {} },
];

const sizeRule = (property: string): NodeRule => ({
  id: "r1",
  on: true,
  scope: "",
  when: { kind: "always" },
  set: { sizeBy: { property, min: 5, max: 17 } },
});

describe("size by value", () => {
  it("maps the values onto the sizes by their square root; nodes without a number keep theirs", () => {
    const out = evaluateRules([sizeRule("pagerank")], items);
    expect(out.styles[0]?.set.size).toBe(5);
    expect(out.styles[1]?.set.size).toBe(17);
    // Half the range of values is about 71 % of the range of sizes (the area grows with it).
    expect(out.styles[2]?.set.size).toBeCloseTo(5 + 12 * Math.SQRT1_2, 1);
    expect(out.styles[3]?.set.size).toBeUndefined();
    expect(out.styles[0]?.set).not.toHaveProperty("sizeBy");
  });

  it("rests when no node has the property, as when its step is turned off", () => {
    expect(evaluateRules([sizeRule("score")], items).rules[0]?.state).toBe("dormant");
  });

  it("is read back from the stored form within the bounds, smallest first", () => {
    const style = parseGraphStyle({
      version: 1,
      nodes: [
        { ...sizeRule("pagerank"), set: { sizeBy: { property: "pagerank", min: 90, max: 3 } } },
      ],
      edges: [],
    });
    expect(style.nodes[0]?.set.sizeBy).toEqual({ property: "pagerank", min: 3, max: 40 });
    const empty = parseGraphStyle({
      version: 1,
      nodes: [{ ...sizeRule(""), set: { sizeBy: { property: "", min: 3, max: 9 } } }],
      edges: [],
    });
    expect(empty.nodes[0]?.set.sizeBy).toBeUndefined();
  });

  it("is what a step's result adds, after the rules already there", () => {
    const first = withResultRule(EMPTY_STYLE, "size", "pagerank");
    expect(first.number).toBe(1);
    const second = withResultRule(first.style, "groups", "community");
    expect(second.number).toBe(2);
    expect(second.style.nodes.map((r) => r.when.kind)).toEqual(["always", "values"]);
    expect(second.style.nodes[0]?.id).not.toBe(second.style.nodes[1]?.id);
  });
});
