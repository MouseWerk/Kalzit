import { project } from "./projection";

/**
 * The outlines the map draws without map images: land, large lakes and the borders of countries
 * (`world.kzo`), and the borders of first-level regions (`regions.kzo`), from Natural Earth
 * (public domain), simplified. `scripts/map-outlines.mjs` builds the files and describes their
 * format. They ship with Kalzit and load with the first map; no request leaves the server.
 */

/** The world square in the units of the outline paths; the view scales them to pixels. */
export const OUTLINE_UNITS = 2 ** 20;

export const OUTLINE_KINDS = ["land", "lake", "country", "region"] as const;
export type OutlineKind = (typeof OUTLINE_KINDS)[number];
/** Shapes are filled and closed; borders are lines. */
const CLOSED: Record<OutlineKind, boolean> = {
  land: true,
  lake: true,
  country: false,
  region: false,
};

/** One SVG path per kind, in `OUTLINE_UNITS`. */
export type OutlinePaths = Record<OutlineKind, string>;

const MAGIC = [0x4b, 0x5a, 0x4f, 0x31];

export class OutlineError extends Error {}

/** Turns an outline file into SVG paths. */
export function decodeOutlines(bytes: Uint8Array): OutlinePaths {
  if (bytes.length < 12 || MAGIC.some((byte, i) => bytes[i] !== byte)) {
    throw new OutlineError("not an outline file");
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = header.getUint32(4, true);
  const count = header.getUint32(8, true);
  let at = 12;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++];
      if (byte === undefined) {
        throw new OutlineError("the outline file ends early");
      }
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        return value;
      }
      shift += 7;
    }
  };
  const signed = (): number => {
    const value = varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  };
  const parts: Record<OutlineKind, string[]> = { land: [], lake: [], country: [], region: [] };
  for (let path = 0; path < count; path++) {
    const kind = OUTLINE_KINDS[bytes[at++] ?? -1];
    if (kind === undefined) {
      throw new OutlineError("unknown kind of outline");
    }
    const points = varint();
    let [lon, lat] = [0, 0];
    let [lastX, lastY] = [0, 0];
    let d = "";
    for (let i = 0; i < points; i++) {
      lon += signed();
      lat += signed();
      const world = project(lat / scale, lon / scale);
      const x = Math.round(world.x * OUTLINE_UNITS);
      const y = Math.round(world.y * OUTLINE_UNITS);
      if (i === 0) {
        d = `M${x} ${y}`;
      } else if (x !== lastX || y !== lastY) {
        d += `l${x - lastX} ${y - lastY}`;
      }
      [lastX, lastY] = [x, y];
    }
    parts[kind].push(CLOSED[kind] ? `${d}Z` : d);
  }
  return {
    land: parts.land.join(""),
    lake: parts.lake.join(""),
    country: parts.country.join(""),
    region: parts.region.join(""),
  };
}

export type OutlineFile = "world" | "regions";

const loaded = new Map<OutlineFile, Promise<OutlinePaths>>();

/** The paths of an outline file, fetched and decoded once per page. */
export function loadOutlines(file: OutlineFile): Promise<OutlinePaths> {
  let paths = loaded.get(file);
  if (paths === undefined) {
    paths = (
      file === "world" ? import("./outlines/world.kzo?url") : import("./outlines/regions.kzo?url")
    )
      .then((module) => fetch(module.default))
      .then((response) => {
        if (!response.ok) {
          throw new OutlineError(`outlines answered ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => decodeOutlines(new Uint8Array(buffer)));
    // A failed load is tried again by the next map.
    paths.catch(() => loaded.delete(file));
    loaded.set(file, paths);
  }
  return paths;
}
