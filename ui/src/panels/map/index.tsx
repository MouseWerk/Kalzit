import { loadArea } from "../../i18n/i18n";
import { lazyPanel } from "../lazy";
import type { PanelPlugin } from "../types";
import { type MapOptions, parseMapOptions } from "./options";
import "../panels.css";
import "../viz.css";

/** A small drawing for the panel picker: land, a filled country and three places. */
function MapPreview() {
  return (
    <svg className="preview" viewBox="0 0 64 40" aria-hidden="true">
      <path className="preview__block" d="M6 10L22 5L40 8L58 6L60 24L46 34L24 36L8 30Z" />
      <path className="preview__fill series-2" d="M22 5L40 8L36 22L20 20Z" />
      <circle className="preview__fill series-1" cx="18" cy="26" r="3" />
      <circle className="preview__fill series-1" cx="34" cy="14" r="3" />
      <circle className="preview__fill series-1" cx="50" cy="22" r="3" />
    </svg>
  );
}

/**
 * The map ("Karte", docs/guide/panels.md): layers of points and areas over the outlines that ship
 * with Kalzit. Rows and documents are placed by coordinates, a geohash or a country code, a
 * graph's nodes by their `point`; each shape is read as it is. The panel, its texts and the
 * outlines load with the first map, and no request leaves the server.
 */
export const mapPanel: PanelPlugin<MapOptions> = {
  type: "map",
  name: "panels.type.map",
  description: "panels.describe.map",
  shapes: ["frame", "documents", "graph"],
  options: parseMapOptions,
  fieldOptions: ["standard", "thresholds"],
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
