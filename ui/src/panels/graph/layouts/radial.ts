import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";
import { keepFixed, NODE_GAP, type PlacedLayout, type Work } from "./shared";

/** The least distance between two rings. */
export const RING_GAP = 90;

export interface RadialLayout extends PlacedLayout {
  /** The nodes in the middle: the request's, or the best connected node when it named none. */
  centers: number[];
  /** Per node its ring: 0 for the middle, -1 for nodes no path connects to it. */
  rings: Int32Array;
  /** The radius of each ring, the outer ring of unconnected nodes last (when there is one). */
  radii: number[];
}

/** The node with the most edges, the first of them on a tie; -1 without nodes. */
export function bestConnected(
  request: Pick<LayoutRequest, "count" | "sources" | "targets">,
): number {
  const degree = new Uint32Array(request.count);
  for (let e = 0; e < request.sources.length; e++) {
    const s = request.sources[e] as number;
    const t = request.targets[e] as number;
    if (s === t) continue;
    degree[s] = (degree[s] as number) + 1;
    degree[t] = (degree[t] as number) + 1;
  }
  let best = -1;
  for (let i = 0; i < request.count; i++) {
    if (best < 0 || (degree[i] as number) > (degree[best] as number)) best = i;
  }
  return best;
}

/** The radius at which nodes `width` wide, `angle` apart, do not touch. */
function radiusFor(width: number, angle: number): number {
  return width / (2 * Math.sin(Math.min(angle, Math.PI) / 2));
}

/**
 * Rings around the nodes in the middle: ring 1 holds their neighbours, ring 2 the neighbours of
 * those, and so on by distance. Each node stands in the sector of the node it was reached from,
 * as wide as the leaves behind it, so neighbours stay together and no two nodes share a place.
 * Several nodes in the middle share it on a small ring of their own; what no path connects to
 * the middle forms an outer ring.
 */
export function radialLayout(request: LayoutRequest, work?: Work): RadialLayout {
  const { count, sources, targets, sizes } = request;
  const positions = new Float32Array(count * 2);
  const rings = new Int32Array(count).fill(-1);
  if (count === 0) return { positions, guides: [], centers: [], rings, radii: [] };

  // Neighbours of every node, both directions, as one flat list with an offset per node.
  const offsets = new Uint32Array(count + 1);
  for (let e = 0; e < sources.length; e++) {
    const s = sources[e] as number;
    const t = targets[e] as number;
    if (s === t) continue;
    offsets[s + 1] = (offsets[s + 1] as number) + 1;
    offsets[t + 1] = (offsets[t + 1] as number) + 1;
  }
  for (let i = 0; i < count; i++) {
    offsets[i + 1] = (offsets[i + 1] as number) + (offsets[i] as number);
  }
  const fill = offsets.slice(0, count);
  const adjacent = new Uint32Array(offsets[count] as number);
  for (let e = 0; e < sources.length; e++) {
    const s = sources[e] as number;
    const t = targets[e] as number;
    if (s === t) continue;
    adjacent[fill[s] as number] = t;
    fill[s] = (fill[s] as number) + 1;
    adjacent[fill[t] as number] = s;
    fill[t] = (fill[t] as number) + 1;
  }

  const centers: number[] = [];
  for (const center of request.centers ?? []) {
    if (center < count && !centers.includes(center)) centers.push(center);
  }
  if (centers.length === 0) centers.push(bestConnected(request));

  // Breadth first from the middle: the ring of a node is its distance, its parent the node it
  // was reached from.
  const parent = new Int32Array(count).fill(-1);
  const queue = new Uint32Array(count);
  let tail = 0;
  for (const center of centers) {
    rings[center] = 0;
    queue[tail++] = center;
  }
  for (let head = 0; head < tail; head++) {
    const node = queue[head] as number;
    for (let at = offsets[node] as number; at < (offsets[node + 1] as number); at++) {
      const next = adjacent[at] as number;
      if (rings[next] !== -1) continue;
      rings[next] = (rings[node] as number) + 1;
      parent[next] = node;
      queue[tail++] = next;
    }
  }
  const reached = tail;
  work?.(Math.round(count / 3), count);

  // Leaves behind each node, from the outside in; a sector is as wide as its leaves.
  const leaves = new Float64Array(count);
  const hasChild = new Uint8Array(count);
  for (let i = reached - 1; i >= 0; i--) {
    const node = queue[i] as number;
    if (hasChild[node] === 0) leaves[node] = 1;
    const up = parent[node] as number;
    if (up >= 0) {
      leaves[up] = (leaves[up] as number) + (leaves[node] as number);
      hasChild[up] = 1;
    }
  }
  let rootLeaves = 0;
  for (const center of centers) rootLeaves += leaves[center] as number;

  // Sectors in the order nodes were reached: clockwise from the top, children inside their
  // parent's sector. `from` is where the next child of a node starts.
  const span = new Float64Array(count);
  const angle = new Float64Array(count);
  const from = new Float64Array(count);
  let cursor = Math.PI / 2;
  for (let i = 0; i < reached; i++) {
    const node = queue[i] as number;
    const up = parent[node] as number;
    if (up < 0) {
      span[node] = (2 * Math.PI * (leaves[node] as number)) / rootLeaves;
      from[node] = cursor;
      cursor -= span[node] as number;
    } else {
      span[node] = ((span[up] as number) * (leaves[node] as number)) / (leaves[up] as number);
      from[node] = from[up] as number;
      from[up] = (from[up] as number) - (span[node] as number);
    }
    angle[node] = (from[node] as number) - (span[node] as number) / 2;
  }
  work?.(Math.round((2 * count) / 3), count);

  // Each ring far enough out that its narrowest sector holds its node, and RING_GAP beyond the
  // ring before it.
  let depth = 0;
  for (let i = 0; i < reached; i++) depth = Math.max(depth, rings[queue[i] as number] as number);
  const need = new Float64Array(depth + 1);
  for (let i = 0; i < reached; i++) {
    const node = queue[i] as number;
    const ring = rings[node] as number;
    if (ring === 0 && centers.length === 1) continue;
    const width = 2 * (sizes[node] ?? 0) + NODE_GAP;
    need[ring] = Math.max(need[ring] as number, radiusFor(width, span[node] as number));
  }
  const radii: number[] = [];
  for (let ring = 0; ring <= depth; ring++) {
    const before = ring === 0 ? 0 : (radii[ring - 1] as number) + RING_GAP;
    radii.push(Math.max(before, need[ring] as number));
  }
  for (let i = 0; i < reached; i++) {
    const node = queue[i] as number;
    const radius = radii[rings[node] as number] as number;
    // A single node in the middle stands at the origin itself (the array starts at zero).
    if (radius === 0) continue;
    positions[2 * node] = radius * Math.cos(angle[node] as number);
    positions[2 * node + 1] = radius * Math.sin(angle[node] as number);
  }

  // What no path connects to the middle: evenly on a ring of its own, outside the others.
  const apart = count - reached;
  if (apart > 0) {
    let widest = 0;
    for (let i = 0; i < count; i++) {
      if (rings[i] === -1) widest = Math.max(widest, 2 * (sizes[i] ?? 0) + NODE_GAP);
    }
    const step = (2 * Math.PI) / apart;
    const radius = Math.max(
      (radii[depth] as number) + RING_GAP,
      apart > 1 ? radiusFor(widest, step) : 0,
    );
    radii.push(radius);
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (rings[i] !== -1) continue;
      const a = Math.PI / 2 - at * step;
      positions[2 * i] = radius * Math.cos(a);
      positions[2 * i + 1] = radius * Math.sin(a);
      at++;
    }
  }

  const guides: LayoutGuide[] = radii
    .filter((radius) => radius > 0)
    .map((radius) => ({ kind: "ring", x: 0, y: 0, radius }));
  work?.(count, count);
  return { positions: keepFixed(positions, request), guides, centers, rings, radii };
}
