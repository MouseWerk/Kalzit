import type { LayoutRequest } from "../layoutProtocol";
import { isFixed, keepFixed, NODE_GAP, type PlacedLayout } from "./shared";

/** The smallest circle, so a handful of nodes does not sit in a knot. */
export const MIN_CIRCLE_RADIUS = 60;

/** The nodes a layout places itself, in the request's order: all but the pinned ones. */
export function movable(request: LayoutRequest): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(request.count);
  const take = (node: number) => {
    if (node < request.count && seen[node] === 0) {
      seen[node] = 1;
      if (!isFixed(request, node)) out.push(node);
    }
  };
  for (const node of request.order ?? []) take(node);
  // Nodes the order left out follow by index, so none is forgotten.
  for (let node = 0; node < request.count; node++) take(node);
  return out;
}

/**
 * All nodes on one circle, clockwise from the top in the request's order. Each node gets an arc
 * as long as it is wide, and the circle is as large as the closest pair needs, so none touch.
 */
export function circularLayout(request: LayoutRequest): PlacedLayout & { radius: number } {
  const positions = new Float32Array(request.count * 2);
  const nodes = movable(request);
  const n = nodes.length;
  if (n <= 1) {
    return { positions: keepFixed(positions, request), guides: [], radius: 0 };
  }
  const widths = nodes.map((node) => 2 * (request.sizes[node] ?? 0) + NODE_GAP);
  const total = widths.reduce((sum, width) => sum + width, 0);
  let radius = Math.max(MIN_CIRCLE_RADIUS, total / (2 * Math.PI));
  for (let i = 0; i < n; i++) {
    const a = widths[i] as number;
    const b = widths[(i + 1) % n] as number;
    // Two neighbours stand half of each one's arc apart.
    const between = Math.min(Math.PI, (Math.PI * (a + b)) / total);
    radius = Math.max(radius, (a + b) / 2 / (2 * Math.sin(between / 2)));
  }
  let at = Math.PI / 2;
  nodes.forEach((node, i) => {
    const share = (2 * Math.PI * (widths[i] as number)) / total;
    const angle = at - share / 2;
    at -= share;
    positions[2 * node] = radius * Math.cos(angle);
    positions[2 * node + 1] = radius * Math.sin(angle);
  });
  return {
    positions: keepFixed(positions, request),
    guides: [{ kind: "ring", x: 0, y: 0, radius }],
    radius,
  };
}
