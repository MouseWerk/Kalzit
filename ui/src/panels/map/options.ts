import { isRecord } from "../../api/client";
import { clipChars } from "../../lib/chars";

/** Where a place comes from: found by name and type, one point value, or two numbers. */
export const COORD_MODES = ["auto", "point", "latLon"] as const;
export type CoordMode = (typeof COORD_MODES)[number];
/** The bundled outlines under the data while there are no map images. */
export const OUTLINE_MODES = ["regions", "countries", "none"] as const;
export type OutlineMode = (typeof OUTLINE_MODES)[number];
export const FIT_MODES = ["data", "world"] as const;
export type FitMode = (typeof FIT_MODES)[number];
export const EDGE_MODES = ["straight", "none"] as const;
export type EdgeMode = (typeof EDGE_MODES)[number];

/** Pixels below which near nodes are bundled; 0 never bundles. */
export const CLUSTER_DISTANCE = { min: 0, max: 80, default: 12 } as const;
/** Names of fields and properties are stored up to this length, as the graph panels do. */
export const MAX_FIELD_CHARS = 100;

export interface MapOptions {
  coords: CoordMode;
  /** The property or field holding a point (`point`, GeoJSON); empty finds one. */
  pointField: string;
  /** The two number properties or columns; empty finds them by name. */
  latField: string;
  lonField: string;
  /** A number column that sets the size of row points; empty draws all alike. */
  sizeField: string;
  /** The property or field named on a point; empty picks the usual ones. */
  caption: string;
  outlines: OutlineMode;
  fit: FitMode;
  edges: EdgeMode;
  clusterDistance: number;
}

function oneOf<T extends string>(values: readonly T[], value: unknown, otherwise: T): T {
  return values.includes(value as T) ? (value as T) : otherwise;
}

function text(value: unknown): string {
  return typeof value === "string" ? clipChars(value.trim(), MAX_FIELD_CHARS) : "";
}

export function parseMapOptions(stored: unknown): MapOptions {
  const value = isRecord(stored) ? stored : {};
  const distance = value.clusterDistance;
  return {
    coords: oneOf(COORD_MODES, value.coords, "auto"),
    pointField: text(value.pointField),
    latField: text(value.latField),
    lonField: text(value.lonField),
    sizeField: text(value.sizeField),
    caption: text(value.caption),
    outlines: oneOf(OUTLINE_MODES, value.outlines, "regions"),
    fit: oneOf(FIT_MODES, value.fit, "data"),
    edges: oneOf(EDGE_MODES, value.edges, "straight"),
    clusterDistance:
      typeof distance === "number" &&
      Number.isInteger(distance) &&
      distance >= CLUSTER_DISTANCE.min &&
      distance <= CLUSTER_DISTANCE.max
        ? distance
        : CLUSTER_DISTANCE.default,
  };
}
