import { type GraphPanelOptions, parseGraphOptions } from "../graph/options";
import { lazyPanel } from "../lazy";
import type { PanelPlugin } from "../types";

/** Nodes and edges in a force layout (docs/PLAN.md, section 2, "Netzwerk-Panel"). */
export const networkPanel: PanelPlugin<GraphPanelOptions> = {
  type: "network",
  name: "graph.panels.network",
  shapes: ["graph"],
  options: parseGraphOptions,
  Panel: lazyPanel(() => import("../graph/GraphPanels").then((m) => m.NetworkPanel)),
  Editor: lazyPanel(() => import("../graph/GraphPanels").then((m) => m.NetworkEditor)),
};
