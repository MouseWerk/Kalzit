import type { NodeShape } from "./shapes";

/**
 * Which node labels would cover another node or a label placed before them, for the current
 * camera. The renderer's own label grid only spreads labels over the panel; in a small panel the
 * fitted drawing puts nodes close together, and a label drawn to the right of its node then runs
 * over the next one ("UPS A1" over "UPS A2"). Labels are placed in order (forced ones first, then
 * the best connected), and one that would collide, or run out of the panel, is left out until
 * the camera gives it room. Pure, in viewport pixels, so it is tested without WebGL; labelRoom.ts
 * runs it on every frame the renderer draws.
 */

/** A drawn node: where its centre is on the panel, how far its shape reaches and the shape. */
export interface DrawnNode {
  index: number;
  x: number;
  y: number;
  /** The circle's radius, the square's half side or the diamond's half diagonal, in px. */
  radius: number;
  shape?: NodeShape;
}

/** A box in viewport px. */
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A label that wants to show: its node and the box it takes on the panel. */
export interface WantedLabel {
  index: number;
  box: Box;
  /** Shown whatever it covers (a selected node, labels set to always). */
  forced: boolean;
}

/** Space between a node and its label, as the renderer draws it (sigma's label margin). */
export const LABEL_MARGIN = 5;
/** The label's background reaches this far around its text (drawing.ts gives it this padding). */
export const LABEL_PAD = 2;

const CELL = 48;

/** The box a label of this text size takes to the right of its node, centred vertically. */
export function labelBox(node: DrawnNode, width: number, height: number): Box {
  const minX = node.x + node.radius + LABEL_MARGIN - LABEL_PAD;
  return {
    minX,
    maxX: minX + width + 2 * LABEL_PAD,
    minY: node.y - height / 2 - LABEL_PAD,
    maxY: node.y + height / 2 + LABEL_PAD,
  };
}

/** Distance from a value to a range (0 inside it). */
function gap(value: number, min: number, max: number): number {
  return value < min ? min - value : value > max ? value - max : 0;
}

/** Whether a node's shape reaches into a box. */
export function nodeHitsBox(node: DrawnNode, box: Box): boolean {
  const dx = gap(node.x, box.minX, box.maxX);
  const dy = gap(node.y, box.minY, box.maxY);
  switch (node.shape ?? "circle") {
    case "square":
      return dx < node.radius && dy < node.radius;
    case "diamond":
      return dx + dy < node.radius;
    default:
      return dx * dx + dy * dy < node.radius * node.radius;
  }
}

export function boxesMeet(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** A uniform grid over the panel: what lies near a box, without testing everything. */
export class Grid<T> {
  private readonly cells = new Map<number, T[]>();

  constructor(private readonly cell = CELL) {}

  private *keys(box: Box): Generator<number> {
    const x0 = Math.floor(box.minX / this.cell);
    const x1 = Math.floor(box.maxX / this.cell);
    const y0 = Math.floor(box.minY / this.cell);
    const y1 = Math.floor(box.maxY / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        // Two signed 16-bit halves: panels are far smaller than 32768 cells across.
        yield ((x & 0xffff) << 16) | (y & 0xffff);
      }
    }
  }

  add(box: Box, item: T): void {
    for (const key of this.keys(box)) {
      const list = this.cells.get(key);
      if (list === undefined) this.cells.set(key, [item]);
      else list.push(item);
    }
  }

  /** Whether anything lies in a cell this box reaches (no allocation). */
  reaches(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const y0 = Math.floor(minY / this.cell);
    const y1 = Math.floor(maxY / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (this.cells.has(((x & 0xffff) << 16) | (y & 0xffff))) return true;
      }
    }
    return false;
  }

  /**
   * Walks what lies in the cells a box reaches, cell by cell and without collecting it (an item in
   * several cells comes once per cell), until `test` answers true or `budget` items were visited.
   * Returns whether a test answered true, how many items were visited, and whether the budget
   * cut the walk short.
   */
  some(
    box: Box,
    test: (item: T) => boolean,
    budget: number,
  ): { hit: boolean; visited: number; cut: boolean } {
    let visited = 0;
    for (const key of this.keys(box)) {
      for (const item of this.cells.get(key) ?? []) {
        if (visited >= budget) return { hit: false, visited, cut: true };
        visited++;
        if (test(item)) return { hit: true, visited, cut: false };
      }
    }
    return { hit: false, visited, cut: false };
  }
}

/**
 * Tests of a label against a node or another label per call. Nodes clumped into a few grid cells
 * would otherwise cost every label a test against each of them; beyond this budget the labels
 * still to place are left out (until zooming spreads the clump).
 */
export const MAX_TESTS = 200_000;

/**
 * The labels (node indexes) to leave out: each that would cover another node, a label placed
 * before it, or reach out of `bounds` (the panel) when given. `labels` comes in order of
 * priority; forced labels are always placed, before the others.
 */
export function blockedLabels(
  nodes: readonly DrawnNode[],
  labels: readonly WantedLabel[],
  bounds?: Box,
  maxTests = MAX_TESTS,
): Set<number> {
  let tests = 0;
  const shapes = new Grid<DrawnNode>();
  for (const node of nodes) {
    shapes.add(
      {
        minX: node.x - node.radius,
        maxX: node.x + node.radius,
        minY: node.y - node.radius,
        maxY: node.y + node.radius,
      },
      node,
    );
  }
  const placed = new Grid<Box>();
  const blocked = new Set<number>();
  const ordered = [...labels.filter((l) => l.forced), ...labels.filter((l) => !l.forced)];
  for (const { index, box, forced } of ordered) {
    if (!forced) {
      const outside =
        bounds !== undefined &&
        (box.minX < bounds.minX ||
          box.maxX > bounds.maxX ||
          box.minY < bounds.minY ||
          box.maxY > bounds.maxY);
      let hit = outside || tests >= maxTests;
      // Every node and label visited counts towards the budget, also where they clump into one
      // cell; a label whose test the budget cut short is left out.
      if (!hit) {
        const found = shapes.some(
          box,
          (node) => node.index !== index && nodeHitsBox(node, box),
          maxTests - tests,
        );
        tests += found.visited;
        hit = found.hit || found.cut;
      }
      if (!hit) {
        const found = placed.some(box, (other) => boxesMeet(other, box), maxTests - tests);
        tests += found.visited;
        hit = found.hit || found.cut;
      }
      if (hit) {
        blocked.add(index);
        continue;
      }
    }
    placed.add(box, box);
  }
  return blocked;
}
