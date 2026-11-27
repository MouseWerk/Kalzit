// Builds the outlines the map panel draws without map images (src/panels/map/outlines/*.kzo)
// from Natural Earth, which is in the public domain (https://www.naturalearthdata.com/about/terms-of-use/).
// Run by hand when the outlines should change; the result is checked in.
//
//   node scripts/map-outlines.mjs <folder with the Natural Earth GeoJSON files>
//
// Needed files (https://github.com/nvkelso/natural-earth-vector, folder geojson/):
//   ne_50m_land.geojson                             land, as filled shapes
//   ne_50m_lakes.geojson                            the large lakes, as filled shapes
//   ne_50m_admin_0_boundary_lines_land.geojson      borders between countries, as lines
//   ne_10m_admin_1_states_provinces_lines.geojson   borders of first-level regions, as lines
//
// Borders are lines, not one shape per country: a shared border is stored once, and simplifying
// it cannot open a gap between two neighbours.
//
// File format (.kzo), all numbers little-endian:
//   "KZO1", u32 scale (steps per degree), u32 number of paths, then per path:
//   u8 kind (KINDS below), varint number of points, then per point the zigzag varint difference
//   to the point before in steps, longitude then latitude (the first point from 0, 0).

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KINDS = { land: 0, lake: 1, country: 2, region: 3 };
/** Steps per degree: 0.002 degrees, about 220 m. */
const SCALE = 500;

/** Douglas-Peucker on [lon, lat] points; the ends always stay. */
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    let worst = -1;
    let worstDistance = tolerance * tolerance;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let t = length === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / length;
      t = Math.max(0, Math.min(1, t));
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      const distance = ex * ex + ey * ey;
      if (distance > worstDistance) {
        worst = i;
        worstDistance = distance;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function extent(points) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.max(maxX - minX, maxY - minY);
}

function read(folder, name) {
  return JSON.parse(readFileSync(join(folder, `${name}.geojson`), "utf8")).features;
}

/** The outer rings of polygons and the parts of lines, as lists of points. */
function parts(geometry) {
  switch (geometry?.type) {
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    default:
      return [];
  }
}

function varint(out, value) {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function encode(paths) {
  const out = [0x4b, 0x5a, 0x4f, 0x31];
  const u32 = (v) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(SCALE);
  u32(paths.length);
  let points = 0;
  for (const { kind, steps } of paths) {
    out.push(kind);
    varint(out, steps.length);
    let [lastX, lastY] = [0, 0];
    for (const [x, y] of steps) {
      const [dx, dy] = [x - lastX, y - lastY];
      varint(out, (dx << 1) ^ (dx >> 31));
      varint(out, (dy << 1) ^ (dy >> 31));
      [lastX, lastY] = [x, y];
    }
    points += steps.length;
  }
  return { bytes: Uint8Array.from(out), points };
}

/** Simplified, on the grid, without points that fall on the one before. */
function path(kind, points, tolerance, closed) {
  const steps = [];
  for (const [lon, lat] of simplify(points, tolerance)) {
    const step = [Math.round(lon * SCALE), Math.round(lat * SCALE)];
    const last = steps[steps.length - 1];
    if (last === undefined || last[0] !== step[0] || last[1] !== step[1]) {
      steps.push(step);
    }
  }
  return steps.length >= (closed ? 4 : 2) ? { kind, steps } : null;
}

function build(folder) {
  const world = [];
  for (const feature of read(folder, "ne_50m_land")) {
    for (const ring of parts(feature.geometry)) {
      // Islands smaller than a twentieth of a degree are below a pixel at the zooms outlines serve.
      if (extent(ring) < 0.05) continue;
      const p = path(KINDS.land, ring, 0.02, true);
      if (p !== null) world.push(p);
    }
  }
  for (const feature of read(folder, "ne_50m_lakes")) {
    for (const ring of parts(feature.geometry)) {
      if (extent(ring) < 0.8) continue;
      const p = path(KINDS.lake, ring, 0.03, true);
      if (p !== null) world.push(p);
    }
  }
  for (const feature of read(folder, "ne_50m_admin_0_boundary_lines_land")) {
    for (const line of parts(feature.geometry)) {
      const p = path(KINDS.country, line, 0.02, false);
      if (p !== null) world.push(p);
    }
  }
  const regions = [];
  for (const feature of read(folder, "ne_10m_admin_1_states_provinces_lines")) {
    for (const line of parts(feature.geometry)) {
      if (extent(line) < 0.04) continue;
      const p = path(KINDS.region, line, 0.025, false);
      if (p !== null) regions.push(p);
    }
  }
  return { world, regions };
}

const folder = process.argv[2];
if (folder === undefined) {
  process.stderr.write(
    "usage: node scripts/map-outlines.mjs <folder with the Natural Earth GeoJSON files>\n",
  );
  process.exit(2);
}
const target = resolve(fileURLToPath(import.meta.url), "../../src/panels/map/outlines");
for (const [name, paths] of Object.entries(build(resolve(folder)))) {
  const { bytes, points } = encode(paths);
  writeFileSync(join(target, `${name}.kzo`), bytes);
  process.stdout.write(
    `${name}.kzo: ${paths.length} paths, ${points} points, ${bytes.length} bytes\n`,
  );
}
