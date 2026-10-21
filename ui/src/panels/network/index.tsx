import { GraphEditor } from "../graph/GraphEditor";
import { GraphPanel } from "../graph/GraphPanel";
import { type GraphPanelOptions, parseGraphOptions } from "../graph/options";
import type { PanelPlugin } from "../types";

/** Nodes and edges in a force layout (docs/PLAN.md, section 2, "Netzwerk-Panel"). */
export const networkPanel: PanelPlugin<GraphPanelOptions> = {
  type: "network",
  name: "graph.panels.network",
  shapes: ["graph"],
  options: parseGraphOptions,
  Panel: (props) => <GraphPanel {...props} mode="force" />,
  Editor: (props) => <GraphEditor {...props} network />,
};
