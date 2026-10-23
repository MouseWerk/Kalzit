import { isRecord } from "../../api/client";
import { lazyPanel } from "../lazy";
import { PathPreview } from "../picker/previews";
import type { PanelPlugin } from "../types";

export interface PathOptions {
  caption: string;
  variable: string;
  variableProperty: string;
}

function parseOptions(stored: unknown): PathOptions {
  const value = isRecord(stored) ? stored : {};
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
  return {
    caption: text(value.caption),
    variable: text(value.variable).replace(/^\$/, ""),
    variableProperty: text(value.variableProperty),
  };
}

/** Shortest paths and other paths as readable sequences (docs/PLAN.md, "Pfad-Panel"). */
export const pathPanel: PanelPlugin<PathOptions> = {
  type: "path",
  name: "graph.panels.path",
  description: "panels.describe.path",
  shapes: ["graph"],
  options: parseOptions,
  Panel: lazyPanel(() => import("./PathPanel").then((m) => m.PathPanel)),
  Editor: lazyPanel(() => import("./PathPanel").then((m) => m.PathEditor)),
  Preview: PathPreview,
};
