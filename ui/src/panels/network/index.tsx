import { loadArea } from "../../i18n/i18n";
import { type GraphPanelOptions, parseGraphOptions } from "../graph/options";
import { lazyPanel } from "../lazy";
import { NetworkPreview } from "../picker/previews";
import type { PanelPlugin } from "../types";

/** Nodes and edges in a force layout (docs/PLAN.md, section 2, "Netzwerk-Panel"). */
export const networkPanel: PanelPlugin<GraphPanelOptions> = {
  type: "network",
  name: "graph.panels.network",
  description: "panels.describe.network",
  shapes: ["graph"],
  options: parseGraphOptions,
  Panel: lazyPanel(() =>
    loadArea("graphStyle")
      .then(() => import("../graph/GraphPanels"))
      .then((m) => m.NetworkPanel),
  ),
  Editor: lazyPanel(() =>
    loadArea("graphStyle")
      .then(() => import("../graph/GraphPanels"))
      .then((m) => m.NetworkEditor),
  ),
  Preview: NetworkPreview,
};
