import { isRecord } from "../../api/client";
import { clipChars } from "../../lib/chars";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";

/**
 * The options of the map panel (board XYMapTrend.dc.html, frames 3 and 4): up to four layers,
 * each a way to draw the same places, and the map's own settings. The server checks the same
 * shape and bounds (`server/src/dashboards/panel_options.rs`, "map").
 */

/** Points and areas first (board decision 2); density and lines follow. */
export const LAYER_KINDS = ["points", "areas"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
/** Where a row's place comes from: found by name and type, two numbers, a geohash, a code. */
export const PLACE_MODES = ["auto", "coords", "geohash", "lookup"] as const;
export type PlaceMode = (typeof PLACE_MODES)[number];
/** How a layer colours its places: one colour, a light-to-dark scale, the panel's thresholds. */
export const COLOR_MODES = ["single", "scale", "thresholds"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
/** The bundled outlines under the data. */
export const OUTLINE_MODES = ["regions", "countries", "none"] as const;
export type OutlineMode = (typeof OUTLINE_MODES)[number];
export const FIT_MODES = ["data", "world"] as const;
export type FitMode = (typeof FIT_MODES)[number];
export const EDGE_MODES = ["straight", "none"] as const;
export type EdgeMode = (typeof EDGE_MODES)[number];

/** At most four layers per map (board frame 4). */
export const MAX_LAYERS = 4;
/** Which result a layer reads: 0 is every result, 1 to this the n-th. */
export const MAX_RESULT = 20;
/** Code pairs per layer ("UK" → "GB"). */
export const MAX_ALIASES = 50;
/** Pixels below which near points are bundled; 0 never bundles. */
export const CLUSTER_DISTANCE = { min: 0, max: 80, default: 12 } as const;
/** Point radius in pixels, from and to (board frame 3: 4 px to 16 px). */
export const POINT_SIZE = { min: 2, max: 40, from: 4, to: 16 } as const;
/** Names of fields are stored up to this length, as the graph panels do. */
export const MAX_FIELD_CHARS = 100;

export interface MapLayer {
  kind: LayerKind;
  /** 0: every frame and document set of the panel; n: the n-th of them. */
  result: number;
  place: PlaceMode;
  /** Two number fields; empty finds them by name (lat/lon, latitude/longitude). */
  latField: string;
  lonField: string;
  /** A field holding a point (`point`, GeoJSON, WKT); empty finds one. */
  pointField: string;
  geohashField: string;
  /** A field holding a country code (ISO 3166-1, two or three letters). */
  keyField: string;
  /** Points: the number that sets their size; areas: the number that colours them. */
  valueField: string;
  color: ColorMode;
  sizeFrom: number;
  sizeTo: number;
  /** The field named on a point; empty picks the usual ones. */
  caption: string;
  /** Keys of the data and the code each stands for, added from the "not found" hint. */
  aliases: Record<string, string>;
}

export interface MapOptions {
  /** Top first: the first layer lies in front. */
  layers: MapLayer[];
  outlines: OutlineMode;
  fit: FitMode;
  edges: EdgeMode;
  clusterDistance: number;
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, otherwise: T): T {
  return values.includes(value as T) ? (value as T) : otherwise;
}

function text(value: unknown): string {
  return typeof value === "string" ? clipChars(value.trim(), MAX_FIELD_CHARS) : "";
}

function whole(value: unknown, min: number, max: number, otherwise: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : otherwise;
}

/** A code as the lookup takes it: two or three letters, upper case. */
export function isCode(value: string): boolean {
  return /^[A-Z]{2,3}$/.test(value);
}

function aliases(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, code] of Object.entries(value).slice(0, MAX_ALIASES)) {
    const from = clipChars(key.trim(), MAX_FIELD_CHARS);
    if (from !== "" && typeof code === "string" && isCode(code)) {
      out[from] = code;
    }
  }
  return out;
}

export function newLayer(kind: LayerKind): MapLayer {
  return {
    kind,
    result: 0,
    // Areas are filled by code; points find their place.
    place: kind === "areas" ? "lookup" : "auto",
    latField: "",
    lonField: "",
    pointField: "",
    geohashField: "",
    keyField: "",
    valueField: "",
    color: kind === "areas" ? "scale" : "single",
    sizeFrom: POINT_SIZE.from,
    sizeTo: POINT_SIZE.to,
    caption: "",
    aliases: {},
  };
}

export function parseLayer(stored: unknown): MapLayer {
  const value = isRecord(stored) ? stored : {};
  const kind = oneOf(LAYER_KINDS, value.kind, "points");
  const base = newLayer(kind);
  const sizeFrom = whole(value.sizeFrom, POINT_SIZE.min, POINT_SIZE.max, base.sizeFrom);
  const sizeTo = whole(value.sizeTo, POINT_SIZE.min, POINT_SIZE.max, base.sizeTo);
  return {
    kind,
    result: whole(value.result, 0, MAX_RESULT, 0),
    // An area is always found by its code.
    place: kind === "areas" ? "lookup" : oneOf(PLACE_MODES, value.place, base.place),
    latField: text(value.latField),
    lonField: text(value.lonField),
    pointField: text(value.pointField),
    geohashField: text(value.geohashField),
    keyField: text(value.keyField),
    valueField: text(value.valueField),
    color:
      kind === "areas"
        ? oneOf(["scale", "thresholds"] as const, value.color, "scale")
        : oneOf(COLOR_MODES, value.color, base.color),
    sizeFrom: Math.min(sizeFrom, sizeTo),
    sizeTo: Math.max(sizeFrom, sizeTo),
    caption: text(value.caption),
    aliases: aliases(value.aliases),
  };
}

export function parseMapOptions(stored: unknown): MapOptions {
  const value = isRecord(stored) ? stored : {};
  const layers = Array.isArray(value.layers)
    ? value.layers.slice(0, MAX_LAYERS).map(parseLayer)
    : [];
  return {
    layers: layers.length === 0 ? [newLayer("points")] : layers,
    outlines: oneOf(OUTLINE_MODES, value.outlines, "regions"),
    fit: oneOf(FIT_MODES, value.fit, "data"),
    edges: oneOf(EDGE_MODES, value.edges, "straight"),
    clusterDistance: whole(
      value.clusterDistance,
      CLUSTER_DISTANCE.min,
      CLUSTER_DISTANCE.max,
      CLUSTER_DISTANCE.default,
    ),
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
}
