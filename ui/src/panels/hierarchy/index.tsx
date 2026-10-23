import { type GraphPanelOptions, parseGraphOptions } from "../graph/options";
import { lazyPanel } from "../lazy";
import { HierarchyPreview } from "../picker/previews";
import type { PanelPlugin } from "../types";

/** Never clusters: a group would cut through the layers. */
function parseOptions(stored: unknown): GraphPanelOptions {
  return { ...parseGraphOptions(stored), cluster: "off" };
}

/**
 * Directed, acyclic structures in layers, edges pointing down: dependencies, org charts
 * (docs/PLAN.md, section 2, "Hierarchie-/Baum-Layout").
 */
export const hierarchyPanel: PanelPlugin<GraphPanelOptions> = {
  type: "hierarchy",
  name: "graph.panels.hierarchy",
  description: "panels.describe.hierarchy",
  shapes: ["graph"],
  options: parseOptions,
  Panel: lazyPanel(() => import("../graph/GraphPanels").then((m) => m.HierarchyPanel)),
  Editor: lazyPanel(() => import("../graph/GraphPanels").then((m) => m.HierarchyEditor)),
  Preview: HierarchyPreview,
};
