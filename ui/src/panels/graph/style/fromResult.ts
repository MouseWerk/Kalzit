import { type GraphStyle, type NodeRule, newRuleId, readableStyle, STYLE_VERSION } from "./schema";

/**
 * A rule from a step's result (board Graph082, frames 5 and 6, decisions 1 and 2): "Als Größe
 * zeigen" makes a size by the value of the step's property, "Farbe je Community" one color per
 * value. The rule is added at the end of the list, visible and editable like any other, and it
 * rests when the step is turned off.
 */
export type ResultRule = "size" | "groups";

export function withResultRule(
  style: GraphStyle,
  use: ResultRule,
  property: string,
): { style: GraphStyle; number: number } {
  const base = readableStyle(style);
  const id = newRuleId(base);
  const rule: NodeRule =
    use === "size"
      ? {
          id,
          on: true,
          scope: "",
          when: { kind: "always" },
          set: { sizeBy: { property, min: 5, max: 17 } },
        }
      : { id, on: true, scope: "", when: { kind: "values", property, colors: [] }, set: {} };
  return {
    style: { version: STYLE_VERSION, nodes: [...base.nodes, rule], edges: base.edges },
    number: base.nodes.length + base.edges.length + 1,
  };
}
