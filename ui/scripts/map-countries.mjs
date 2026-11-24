// Builds the country areas the map panel fills by country code (src/panels/map/outlines/countries.kzc)
// from Natural Earth (public domain, https://www.naturalearthdata.com/about/terms-of-use/), as the
// npm package world-atlas 2.0.2 ships it (countries-50m.json, TopoJSON, ISO 3166-1 numeric ids),
// with the two- and three-letter codes from the package i18n-iso-countries (codes.json).
// Run by hand when the areas should change; the result is checked in. Neither package is a
// dependency of the UI: install them into any folder and name that folder.
//
//   node scripts/map-countries.mjs <folder whose node_modules hold world-atlas, topojson-client
//                                   and i18n-iso-countries>
//
// File format (.kzc), all numbers little-endian:
//   "KZC1", u32 scale (steps per degree), u32 number of countries, then per country:
//   2 bytes two-letter code, 3 bytes three-letter code (ASCII), zigzag varint longitude and
//   latitude of its middle in steps, varint number of rings, then per ring: varint number of
//   points and per point the zigzag varint difference to the point before in steps, longitude
//   then latitude (the first point of each ring from 0, 0).
// Rings are outer rings only: the map fills areas, and the few holes (enclaves) are other
// countries drawn on top.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Steps per degree: 0.01 degrees, about 1 km; the areas are simplified far coarser anyway. */
const SCALE = 100;
/** Douglas-Peucker tolerance in degrees. */
const TOLERANCE = 0.04;
/** Rings smaller than this (largest side in degrees) are left out, unless a country has no other. */
const MIN_EXTENT = 0.25;

function simplify(points, tolerance) {
  if (points.length <= 4) return points;
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

/** Area and middle of a ring (shoelace formula, in degrees). */
function areaAndMiddle(points) {
  let [area, cx, cy] = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (area === 0) {
    return { area: 0, middle: points[0] };
  }
  return { area: Math.abs(area / 2), middle: [cx / (3 * area), cy / (3 * area)] };
}

function outerRings(geometry) {
  if (geometry === null) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((polygon) => polygon[0]);
  return [];
}

class Writer {
  bytes = [];
  u8(value) {
    this.bytes.push(value & 0xff);
  }
  u32(value) {
    for (let i = 0; i < 4; i++) this.u8(value >>> (8 * i));
  }
  ascii(text) {
    for (const char of text) this.u8(char.charCodeAt(0));
  }
  varint(value) {
    let rest = value;
    while (rest >= 0x80) {
      this.u8((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.u8(rest);
  }
  signed(value) {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }
}

function main() {
  const folder = process.argv[2];
  if (folder === undefined) {
    process.stderr.write("usage: node scripts/map-countries.mjs <folder with node_modules>\n");
    process.exit(2);
  }
  const require = createRequire(join(resolve(folder), "package.json"));
  const { feature } = require("topojson-client");
  const topology = require("world-atlas/countries-50m.json");
  const codes = require("i18n-iso-countries/codes.json");
  const byNumber = new Map(codes.map(([alpha2, alpha3, numeric]) => [numeric, { alpha2, alpha3 }]));
  const countries = feature(topology, topology.objects.countries).features;
  const out = new Writer();
  const entries = [];
  const skipped = [];
  for (const country of countries) {
    const code = byNumber.get(String(country.id ?? "").padStart(3, "0"));
    if (code === undefined) {
      skipped.push(country.properties?.name ?? String(country.id));
      continue;
    }
    const rings = outerRings(country.geometry);
    const largest = rings
      .map((ring) => ({ ring, ...areaAndMiddle(ring) }))
      .sort((a, b) => b.area - a.area)[0];
    if (largest === undefined) {
      skipped.push(country.properties?.name ?? code.alpha2);
      continue;
    }
    let kept = rings.filter((ring) => extent(ring) >= MIN_EXTENT);
    if (kept.length === 0) kept = [largest.ring];
    const steps = kept
      .map((ring) =>
        simplify(ring, TOLERANCE).map(([lon, lat]) => [
          Math.round(lon * SCALE),
          Math.round(lat * SCALE),
        ]),
      )
      .filter((ring) => ring.length >= 3);
    entries.push({ code, middle: largest.middle, rings: steps });
  }
  entries.sort((a, b) => a.code.alpha2.localeCompare(b.code.alpha2));
  out.ascii("KZC1");
  out.u32(SCALE);
  out.u32(entries.length);
  for (const { code, middle, rings } of entries) {
    out.ascii(code.alpha2);
    out.ascii(code.alpha3);
    out.signed(Math.round(middle[0] * SCALE));
    out.signed(Math.round(middle[1] * SCALE));
    out.varint(rings.length);
    for (const ring of rings) {
      out.varint(ring.length);
      let [lastLon, lastLat] = [0, 0];
      for (const [lon, lat] of ring) {
        out.signed(lon - lastLon);
        out.signed(lat - lastLat);
        [lastLon, lastLat] = [lon, lat];
      }
    }
  }
  const target = resolve(
    fileURLToPath(import.meta.url),
    "../../src/panels/map/outlines/countries.kzc",
  );
  writeFileSync(target, Uint8Array.from(out.bytes));
  process.stdout.write(
    `${entries.length} countries, ${out.bytes.length} bytes; without a code: ${skipped.join(", ")}\n`,
  );
}

main();
