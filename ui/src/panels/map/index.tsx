import { loadArea } from "../../i18n/i18n";
import { lazyPanel } from "../lazy";
import type { PanelPlugin } from "../types";
import { type MapOptions, parseMapOptions } from "./options";
import "../panels.css";
import "../viz.css";

/** A small drawing for the panel picker: land, a border and three places joined by lines. */
function MapPreview() {
  return (
    <svg className="preview" viewBox="0 0 64 40" aria-hidden="true">
      <path className="preview__block" d="M6 10L22 5L40 8L58 6L60 24L46 34L24 36L8 30Z" />
      <path className="preview__line series-2" d="M18 26L34 14L50 22" />
      <circle className="preview__fill series-1" cx="18" cy="26" r="3" />
      <circle className="preview__fill series-1" cx="34" cy="14" r="3" />
      <circle className="preview__fill series-1" cx="50" cy="22" r="3" />
    </svg>
  );
}

/**
 * Places on a map (docs/guide/panels.md, "Map"): rows and documents with coordinates as points, a graph
 * with a `point` or two number properties as nodes and edges on the map. It reads each shape as
 * it is. The panel and its texts load with the first map.
 */
export const mapPanel: PanelPlugin<MapOptions> = {
  type: "map",
  name: "panels.type.map",
  description: "panels.describe.map",
  shapes: ["graph", "frame", "documents"],
  options: parseMapOptions,
  Panel: lazyPanel(() =>
    loadArea("map")
      .then(() => import("./MapPanel"))
      .then((m) => m.MapPanel),
  ),
  Editor: lazyPanel(() =>
    loadArea("map")
      .then(() => import("./MapEditor"))
      .then((m) => m.MapEditor),
  ),
  Preview: MapPreview,
};
