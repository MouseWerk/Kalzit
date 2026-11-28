import { isCoordinate, project } from "../../map/projection";
import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";
import { isFixed, largestSize, NODE_GAP, type PlacedLayout, placeStrip, STRIP_GAP } from "./shared";

/** The side of the square the placed nodes fill, for a few nodes; it grows with their number. */
export const MAP_SIDE = 360;
/**
 * The smallest stretch of the world (a share of its width) the square shows: nodes a few metres
 * apart do not zoom the map past what map images and outlines can show.
 */
export const MIN_MAP_SPAN = 2 ** -14;
/** The stretch shown around one place, or around places that all lie on one spot: a region. */
export const SINGLE_MAP_SPAN = 2 ** -8;

export interface MapLayout extends PlacedLayout {
  /** Nodes on the map. */
  placed: number;
  /** Nodes without a place, standing in the strip beside the map. */
  unplaced: number;
}

/**
 * Each node where its longitude and latitude put it on the map (Graph081 board, frames 13 and
 * 15): Web Mercator, as the map panel and map images draw the world, north up, one scale for both
 * directions so distances stay true. The placed nodes fill a square; the map guide says where the
 * whole world lies, so the map is drawn under them. Nodes without a place stand in a strip beside
 * the square, with their number, so none disappears. Their place comes from the data: a pinned
 * node with a place stands at it all the same.
 */
export function mapLayout(request: LayoutRequest): MapLayout {
  const { count } = request;
  const values = request.values ?? new Float64Array(0);
  const positions = new Float32Array(count * 2);
  const world = new Float64Array(count * 2);
  const has = new Uint8Array(count);
  const without: number[] = [];
  let placed = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const lon = values[2 * i] ?? Number.NaN;
    const lat = values[2 * i + 1] ?? Number.NaN;
    if (!isCoordinate(lat, lon)) {
      if (isFixed(request, i)) {
        positions[2 * i] = request.start[2 * i] ?? 0;
        positions[2 * i + 1] = request.start[2 * i + 1] ?? 0;
      } else {
        without.push(i);
      }
      continue;
    }
    const at = project(lat, lon);
    world[2 * i] = at.x;
    world[2 * i + 1] = at.y;
    has[i] = 1;
    placed++;
    minX = Math.min(minX, at.x);
    maxX = Math.max(maxX, at.x);
    minY = Math.min(minY, at.y);
    maxY = Math.max(maxY, at.y);
  }
  const side = Math.max(MAP_SIDE, 48 * Math.sqrt(placed));
  if (placed === 0) {
    // Nothing to fit: the whole world.
    [minX, maxX, minY, maxY] = [0, 1, 0, 1];
  }
  const widest = Math.max(maxX - minX, maxY - minY);
  const span = widest > 0 ? Math.max(widest, MIN_MAP_SPAN) : SINGLE_MAP_SPAN;
  const scale = side / span;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  // Graph coordinates grow upwards and the world's y grows to the south. Positions are taken
  // relative to the middle of the places, so their 32 bits keep a few metres apart.
  const graphX = (x: number) => (x - centerX) * scale + side / 2;
  const graphY = (y: number) => (centerY - y) * scale + side / 2;
  for (let i = 0; i < count; i++) {
    if (has[i] === 0) continue;
    positions[2 * i] = graphX(world[2 * i] as number);
    positions[2 * i + 1] = graphY(world[2 * i + 1] as number);
  }
  const guides: LayoutGuide[] = [{ kind: "map", x: graphX(0), y: graphY(0), side: scale }];
  if (without.length > 0) {
    const cell = 2 * largestSize(request.sizes) + NODE_GAP;
    const box = placeStrip(positions, without, side + STRIP_GAP, side, cell);
    guides.push({ kind: "strip", ...box, count: without.length, reason: "noPlace" });
  }
  return { positions, guides, placed, unplaced: without.length };
}
