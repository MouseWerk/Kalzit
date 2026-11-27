import type { Frame, GraphSet } from "../../api/generated/shapes";

/**
 * Whether a result looks like places, for the panel suggestion. Kept apart from the panel's own
 * code: the registry is part of every page, the map loads with its first use.
 */

const LAT_NAMES = ["lat", "latitude", "breite", "breitengrad", "y"];
const LON_NAMES = ["lon", "lng", "long", "longitude", "länge", "laenge", "längengrad", "x"];
export const POINT_NAMES = [
  "location",
  "standort",
  "point",
  "position",
  "coordinates",
  "geo",
  "ort",
];
/** Field names that hold a geohash, as Elasticsearch and OpenSearch name bundled places. */
export const GEOHASH_NAMES = ["geohash", "geohash_grid", "hash", "zelle", "cell"];
/** Field names that hold a country code. */
export const CODE_NAMES = [
  "country_code",
  "countrycode",
  "country",
  "iso",
  "iso2",
  "iso3",
  "iso_a2",
  "iso_a3",
  "land",
  "laendercode",
  "ländercode",
  "code",
];
/** `x` and `y` are only taken as a pair, and last: they name many things that are no place. */
const WEAK_NAMES = new Set(["x", "y"]);

/** The key among `keys` that has one of `names`, the earliest name first; case does not matter. */
export function named(keys: readonly string[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase() === name);
    if (key !== undefined) {
      return key;
    }
  }
  return undefined;
}

const strong = (names: readonly string[]) => names.filter((n) => !WEAK_NAMES.has(n));

/** The two keys that hold latitude and longitude among `keys`, by their usual names. */
export function findLatLonKeys(
  keys: readonly string[],
  weak = true,
): { lat: string; lon: string } | null {
  const lat = named(keys, strong(LAT_NAMES));
  const lon = named(keys, strong(LON_NAMES));
  if (lat !== undefined && lon !== undefined) {
    return { lat, lon };
  }
  const [y, x] = [named(keys, ["y"]), named(keys, ["x"])];
  return weak && lat === undefined && lon === undefined && x !== undefined && y !== undefined
    ? { lat: y, lon: x }
    : null;
}

const NUMERIC = new Set(["number", "int64", "decimal"]);

/** A frame with a latitude and a longitude column, by name and type. */
export function frameHasPlaces(frame: Frame): boolean {
  const pair = findLatLonKeys(
    frame.fields.map((f) => f.name),
    false,
  );
  if (pair === null) {
    return false;
  }
  const type = (name: string) => frame.fields.find((f) => f.name === name)?.type ?? "";
  return NUMERIC.has(type(pair.lat)) && NUMERIC.has(type(pair.lon));
}

function isGeoPoint(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { $type?: unknown }).$type === "point" &&
    [4326, 4979].includes((value as { srid?: unknown }).srid as number)
  );
}

/** A graph where at least half of the nodes carry a geographic `point`. */
export function graphHasPlaces(graph: GraphSet): boolean {
  if (graph.nodes.length === 0) {
    return false;
  }
  const placed = graph.nodes.filter((node) => Object.values(node.properties).some(isGeoPoint));
  return placed.length * 2 >= graph.nodes.length;
}
