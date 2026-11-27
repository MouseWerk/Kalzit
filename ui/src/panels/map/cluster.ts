import type { MapEdge, MapPoint } from "./points";
import { type Size, toScreen, type View } from "./projection";

/**
 * Bundles points that lie closer than a distance on the panel into one circle with their number,
 * and the edges between two bundles into one line that grows with how many it stands for. The
 * bundles depend on the zoom: zooming in takes them apart.
 */

export interface Cluster {
  /** The id of its first point; stable while the same points lead. */
  id: string;
  x: number;
  y: number;
  points: MapPoint[];
}

export interface ClusterEdge {
  id: string;
  from: Cluster;
  to: Cluster;
  /** The edges it stands for. */
  edges: MapEdge[];
}

/**
 * Groups `points` so that every point joins the first bundle whose leading point is within
 * `distance` pixels; points off the panel (beyond `margin`) are left out. `distance` 0 keeps
 * every point alone, except points on the very same pixel position.
 */
export function clusterPoints(
  points: readonly MapPoint[],
  view: View,
  size: Size,
  distance: number,
  margin = 40,
): Cluster[] {
  const cell = Math.max(distance, 0.5);
  const grid = new Map<string, Cluster[]>();
  const clusters: Cluster[] = [];
  const sums = new Map<Cluster, { x: number; y: number }>();
  for (const point of points) {
    const { x, y } = toScreen(point.world, view, size);
    if (x < -margin || y < -margin || x > size.width + margin || y > size.height + margin) {
      continue;
    }
    const [cx, cy] = [Math.floor(x / cell), Math.floor(y / cell)];
    let home: Cluster | undefined;
    for (let dy = -1; dy <= 1 && home === undefined; dy++) {
      for (let dx = -1; dx <= 1 && home === undefined; dx++) {
        home = grid.get(`${cx + dx}:${cy + dy}`)?.find((cluster) => {
          const lead = sums.get(cluster);
          const count = cluster.points.length;
          return (
            lead !== undefined && Math.hypot(lead.x / count - x, lead.y / count - y) <= distance
          );
        });
      }
    }
    if (home === undefined) {
      home = { id: point.id, x, y, points: [point] };
      sums.set(home, { x, y });
      clusters.push(home);
      const key = `${cx}:${cy}`;
      const inCell = grid.get(key);
      if (inCell === undefined) {
        grid.set(key, [home]);
      } else {
        inCell.push(home);
      }
    } else {
      const sum = sums.get(home) as { x: number; y: number };
      sum.x += x;
      sum.y += y;
      home.points.push(point);
      home.x = sum.x / home.points.length;
      home.y = sum.y / home.points.length;
    }
  }
  return clusters;
}

/** The edges between bundles: one line per pair, whichever way its edges point. */
export function clusterEdges(
  edges: readonly MapEdge[],
  clusters: readonly Cluster[],
): ClusterEdge[] {
  const home = new Map<string, Cluster>();
  for (const cluster of clusters) {
    for (const point of cluster.points) {
      home.set(point.id, cluster);
    }
  }
  const lines = new Map<string, ClusterEdge>();
  for (const edge of edges) {
    const [from, to] = [home.get(edge.from), home.get(edge.to)];
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const key = from.id < to.id ? `${from.id}\u0000${to.id}` : `${to.id}\u0000${from.id}`;
    const line = lines.get(key);
    if (line === undefined) {
      lines.set(key, { id: key, from, to, edges: [edge] });
    } else {
      line.edges.push(edge);
    }
  }
  return [...lines.values()];
}

/** Radius of a bundle's circle: grows slowly with the number of points it holds. */
export function clusterRadius(count: number): number {
  return Math.min(26, 9 + 3 * Math.log2(count));
}

/** Width of a line that stands for `count` edges of `width`. */
export function bundledWidth(width: number, count: number): number {
  return Math.min(8, width * (1 + Math.log2(count)));
}
