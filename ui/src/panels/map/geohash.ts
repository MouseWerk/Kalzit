/**
 * Geohash cells as Elasticsearch and OpenSearch return bundled places: a text of base 32
 * characters, each narrowing the cell. The map puts the point in the middle of the cell.
 */

const ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";
/** Twelve characters are a few centimetres; longer texts are no geohash. */
export const MAX_GEOHASH_CHARS = 12;

export function isGeohash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_GEOHASH_CHARS &&
    [...value.toLowerCase()].every((char) => ALPHABET.includes(char))
  );
}

/** The middle of a geohash cell, or null for a text that is no geohash. */
export function decodeGeohash(hash: string): { lat: number; lon: number } | null {
  if (!isGeohash(hash)) {
    return null;
  }
  let [latMin, latMax, lonMin, lonMax] = [-90, 90, -180, 180];
  let even = true;
  for (const char of hash.toLowerCase()) {
    const bits = ALPHABET.indexOf(char);
    for (let bit = 4; bit >= 0; bit--) {
      const on = ((bits >> bit) & 1) === 1;
      if (even) {
        const middle = (lonMin + lonMax) / 2;
        if (on) lonMin = middle;
        else lonMax = middle;
      } else {
        const middle = (latMin + latMax) / 2;
        if (on) latMin = middle;
        else latMax = middle;
      }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}
