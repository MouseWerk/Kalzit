import { isRecord } from "../../api/client";
import { type DataLink, parseDataLinks } from "../dataLinks";
import { MAX_OPTION_TEXT, optionText as text } from "../graph/options";
import { lazyPanel } from "../lazy";
import { PathPreview } from "../picker/previews";
import type { PanelPlugin } from "../types";

export interface PathOptions {
  caption: string;
  variable: string;
  variableProperty: string;
  /** Links from a node or edge property, offered with each step of a path. */
  dataLinks: DataLink[];
}

export function parsePathOptions(stored: unknown): PathOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    caption: text(value.caption),
    variable: text(value.variable).replace(/^\$/, ""),
    variableProperty: text(value.variableProperty),
    dataLinks: parseDataLinks(value.dataLinks, MAX_OPTION_TEXT),
  };
}

/** Shortest paths and other paths as readable sequences (docs/PLAN.md, "Pfad-Panel"). */
export const pathPanel: PanelPlugin<PathOptions> = {
  type: "path",
  name: "graph.panels.path",
  description: "panels.describe.path",
  shapes: ["graph"],
  options: parsePathOptions,
  Panel: lazyPanel(() => import("./PathPanel").then((m) => m.PathPanel)),
  Editor: lazyPanel(() => import("./PathPanel").then((m) => m.PathEditor)),
  Preview: PathPreview,
};
