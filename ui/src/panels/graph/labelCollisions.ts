/**
 * Which node labels would cover another node's circle or a label placed before them, for the
 * current camera. The renderer's own label grid only keeps labels apart from each other; in a
 * small panel the fitted drawing puts nodes close together, and a label drawn to the right of
 * its node then runs over the next circle ("UPS A1" over "UPS A2"). Labels are placed in order
 * (forced ones first, then the best connected), and one that would collide is left out until the
 * camera gives it room. Pure, in viewport pixels, so it is tested without WebGL.
 */

/** A drawn node: where its centre is on the panel and its radius, in px. */
export interface DrawnNode {
  index: number;
  x: number;
  y: number;
  radius: number;
}

/** A label that wants to show, beside its node. */
export interface WantedLabel extends DrawnNode {
  /** Width and height of the text in px. */
  width: number;
  height: number;
  /** Shown whatever it covers (a selected node, labels set to always). */
  forced: boolean;
}

/** Space between a node and its label, as the renderer draws it (sigma's label margin). */
export const LABEL_MARGIN = 5;
/** The label's background reaches this far around its text (drawing.ts). */
export const LABEL_PAD = 2;

const CELL = 48;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box a label takes, to the right of its node and centred on it vertically. */
export function labelBox(label: WantedLabel): Box {
  const minX = label.x + label.radius + LABEL_MARGIN - LABEL_PAD;
  return {
    minX,
    maxX: minX + label.width + 2 * LABEL_PAD,
    minY: label.y - label.height / 2 - LABEL_PAD,
    maxY: label.y + label.height / 2 + LABEL_PAD,
  };
}

function circleHitsBox(node: DrawnNode, box: Box): boolean {
  const nx = Math.max(box.minX, Math.min(node.x, box.maxX));
  const ny = Math.max(box.minY, Math.min(node.y, box.maxY));
  const dx = node.x - nx;
  const dy = node.y - ny;
  return dx * dx + dy * dy < node.radius * node.radius;
}

function boxesMeet(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** A uniform grid over the panel: what lies near a box, without testing everything. */
class Grid<T> {
  private readonly cells = new Map<number, T[]>();

  private *keys(box: Box): Generator<number> {
    const x0 = Math.floor(box.minX / CELL);
    const x1 = Math.floor(box.maxX / CELL);
    const y0 = Math.floor(box.minY / CELL);
    const y1 = Math.floor(box.maxY / CELL);
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

  near(box: Box): Set<T> {
    const out = new Set<T>();
    for (const key of this.keys(box)) {
      for (const item of this.cells.get(key) ?? []) out.add(item);
    }
    return out;
  }
}

/**
 * The labels (node indexes) to leave out: each that would cover another node's circle or a label
 * placed before it. `labels` comes in order of priority; forced labels are always placed.
 */
export function blockedLabels(
  nodes: readonly DrawnNode[],
  labels: readonly WantedLabel[],
): Set<number> {
  const circles = new Grid<DrawnNode>();
  for (const node of nodes) {
    circles.add(
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
  for (const label of ordered) {
    const box = labelBox(label);
    if (!label.forced) {
      let hit = false;
      for (const node of circles.near(box)) {
        if (node.index !== label.index && circleHitsBox(node, box)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const other of placed.near(box)) {
          if (boxesMeet(other, box)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        blocked.add(label.index);
        continue;
      }
    }
    placed.add(box, box);
  }
  return blocked;
}

/** Whether two sets hold the same indexes. */
export function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}
