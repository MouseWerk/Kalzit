import { LABEL_PAD } from "../labelCollisions";
import type { NodeShape } from "../shapes";
import { type FramedScene, type SceneNode, sceneLabelBox } from "./scene";

/**
 * A picture of a graph as a list of plain shapes on a page: the caption, the drawing, the legend
 * and the line that says how much of the graph it shows. The three formats (svg.ts, pdf.ts,
 * raster.ts) each write these shapes in their own way and know nothing about graphs.
 */

export type Op =
  | { kind: "rect"; x: number; y: number; width: number; height: number; fill: string }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string }
  /** A circle's outline: an edge from a node to itself. */
  | { kind: "ring"; cx: number; cy: number; r: number; stroke: string; width: number }
  | { kind: "polygon"; points: readonly number[]; fill: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }
  | {
      kind: "text";
      /** Where the text starts (or its middle, with `anchor: "middle"`), and its baseline. */
      x: number;
      y: number;
      text: string;
      size: number;
      fill: string;
      bold: boolean;
      anchor: "start" | "middle";
      /** The text's measured width in px. */
      width: number;
    };

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Shapes drawn in order, cut at `clip` when it is given. */
export interface Layer {
  /** What the layer holds, as formats name their groups: "caption", "graph", "legend". */
  name: string;
  clip: Clip | null;
  ops: Op[];
}

export interface Picture {
  width: number;
  height: number;
  /** The fill behind everything; null for a transparent picture. */
  background: string | null;
  /** The font family as CSS writes it, and the weight of bold text. */
  font: string;
  boldWeight: string;
  /** The picture's name in the file (an SVG's title, a PDF's document title). */
  title: string;
  layers: Layer[];
}

export interface LegendEntry {
  name: string;
  shape: NodeShape;
  color: string;
  /** How many nodes carry the label, as the legend writes it. */
  count: string;
}

export interface PictureLegend {
  entries: LegendEntry[];
  /** Colors by a number: the ramp's steps and what they stand for ("revenue: 0 to 900"). */
  ramp: { colors: readonly string[]; text: string } | null;
  /** Lines under the entries: what the node sizes stand for, nodes without a value. */
  notes: string[];
}

export interface PictureParts {
  /** The fill behind the picture; null for a transparent one. */
  background: string | null;
  /** The title, and under it lines such as the data source and the time range. */
  caption: { title: string; lines: string[] } | null;
  legend: PictureLegend | null;
  /** The line under the drawing: how many of the graph's nodes it shows. */
  note: string | null;
  /** The picture's name in the file. */
  title: string;
}

/** The width of a text in px at a size. */
export type MeasureAt = (text: string, size: number, bold: boolean) => number;

const PAGE_PADDING = 16;
const TITLE_SIZE = 15;
const TEXT_SIZE = 12;
const LINE = 18;
const SWATCH = 10;
/** The smallest page, so a caption and a legend have room next to a small drawing. */
const MIN_WIDTH = 320;
const MAX_TEXT_WIDTH = 900;
/** A baseline this far under a text's middle centres its letters on it. */
const MIDDLE = 0.34;

/** How far a node's shape reaches from its centre in the direction (ux, uy). */
function reach(node: SceneNode, ux: number, uy: number): number {
  switch (node.shape) {
    case "square":
      return node.radius / Math.max(Math.abs(ux), Math.abs(uy), 1e-6);
    case "diamond":
      return node.radius / Math.max(Math.abs(ux) + Math.abs(uy), 1e-6);
    default:
      return node.radius;
  }
}

function shapeOp(shape: NodeShape, x: number, y: number, r: number, fill: string): Op {
  if (shape === "square") {
    return { kind: "rect", x: x - r, y: y - r, width: 2 * r, height: 2 * r, fill };
  }
  if (shape === "diamond") {
    return { kind: "polygon", points: [x, y - r, x + r, y, x, y + r, x - r, y], fill };
  }
  return { kind: "circle", cx: x, cy: y, r, fill };
}

/** The drawing itself: edges, their labels, nodes, then node labels on top, as the panel does. */
function graphOps(
  scene: FramedScene,
  dx: number,
  dy: number,
  background: string | null,
  measure: MeasureAt,
): Op[] {
  const edges: Op[] = [];
  const edgeLabels: Op[] = [];
  const edgeLabelSize = scene.labelSize - 2;
  for (const edge of scene.edges) {
    const source = scene.nodes[edge.source];
    const target = scene.nodes[edge.target];
    if (source === undefined || target === undefined) continue;
    if (edge.source === edge.target) {
      const r = source.radius * 0.9 + 3;
      edges.push({
        kind: "ring",
        cx: source.x + dx + r * 0.7,
        cy: source.y + dy - r * 0.7,
        r,
        stroke: edge.color,
        width: edge.width,
      });
      continue;
    }
    const length = Math.hypot(target.x - source.x, target.y - source.y);
    if (length <= 0) continue;
    const ux = (target.x - source.x) / length;
    const uy = (target.y - source.y) / length;
    const from = reach(source, ux, uy);
    const to = length - reach(target, ux, uy);
    // Nodes that touch or overlap leave no edge to draw between them.
    if (to <= from) continue;
    const head = Math.max(5, edge.width * 5);
    const arrow = edge.arrow && to - from > head;
    const end = arrow ? to - head : to;
    const at = (d: number): [number, number] => [source.x + dx + ux * d, source.y + dy + uy * d];
    const [x1, y1] = at(from);
    const [x2, y2] = at(end);
    edges.push({ kind: "line", x1, y1, x2, y2, stroke: edge.color, width: edge.width });
    if (arrow) {
      const [tipX, tipY] = at(to);
      const half = head * 0.4;
      edges.push({
        kind: "polygon",
        points: [tipX, tipY, x2 - uy * half, y2 + ux * half, x2 + uy * half, y2 - ux * half],
        fill: edge.color,
      });
    }
    if (edge.label !== null && edge.label !== "") {
      const [mx, my] = at((from + to) / 2);
      const width = measure(edge.label, edgeLabelSize, false);
      if (background !== null) {
        edgeLabels.push({
          kind: "rect",
          x: mx - width / 2 - LABEL_PAD,
          y: my - edgeLabelSize / 2 - LABEL_PAD,
          width: width + 2 * LABEL_PAD,
          height: edgeLabelSize + 2 * LABEL_PAD,
          fill: background,
        });
      }
      edgeLabels.push({
        kind: "text",
        x: mx,
        y: my + edgeLabelSize * MIDDLE,
        text: edge.label,
        size: edgeLabelSize,
        fill: scene.colors.text,
        bold: false,
        anchor: "middle",
        width,
      });
    }
  }
  const nodes: Op[] = [];
  const labels: Op[] = [];
  const labelWidth = (text: string, bold: boolean) => measure(text, scene.labelSize, bold);
  scene.nodes.forEach((node, place) => {
    nodes.push(shapeOp(node.shape, node.x + dx, node.y + dy, node.radius, node.color));
    if (node.label === null || !scene.labelled.has(place)) return;
    const box = sceneLabelBox(node, labelWidth, scene.labelSize);
    // A selected node's label sits on the selection tint; the others on the canvas color, so they
    // stay readable where they cross an edge. A transparent picture has no canvas color.
    const behind = node.selected ? scene.colors.selection : background;
    if (behind !== null) {
      labels.push({
        kind: "rect",
        x: box.minX + dx,
        y: box.minY + dy,
        width: box.maxX - box.minX,
        height: box.maxY - box.minY,
        fill: behind,
      });
    }
    labels.push({
      kind: "text",
      x: box.minX + LABEL_PAD + dx,
      y: node.y + dy + scene.labelSize * MIDDLE,
      text: node.label,
      size: scene.labelSize,
      fill: scene.colors.text,
      bold: node.selected,
      anchor: "start",
      width: labelWidth(node.label, node.selected),
    });
  });
  return [...edges, ...edgeLabels, ...nodes, ...labels];
}

/** The legend's entries in rows that wrap at `width`, then its ramp and notes; and its height. */
function legendOps(
  legend: PictureLegend,
  x: number,
  top: number,
  width: number,
  color: string,
  measure: MeasureAt,
): { ops: Op[]; height: number } {
  const ops: Op[] = [];
  const text = (at: number, baseline: number, value: string): number => {
    const w = measure(value, TEXT_SIZE, false);
    ops.push({
      kind: "text",
      x: at,
      y: baseline,
      text: value,
      size: TEXT_SIZE,
      fill: color,
      bold: false,
      anchor: "start",
      width: w,
    });
    return w;
  };
  let row = 0;
  let at = x;
  for (const entry of legend.entries) {
    const label = entry.count === "" ? entry.name : `${entry.name}  ${entry.count}`;
    const needed = SWATCH + 6 + measure(label, TEXT_SIZE, false);
    if (at > x && at + needed > x + width) {
      row += 1;
      at = x;
    }
    const middle = top + row * LINE + LINE / 2;
    ops.push(shapeOp(entry.shape, at + SWATCH / 2, middle, SWATCH / 2, entry.color));
    text(at + SWATCH + 6, middle + TEXT_SIZE * MIDDLE, label);
    at += needed + 16;
  }
  let y = top + (legend.entries.length > 0 ? (row + 1) * LINE : 0);
  if (legend.ramp !== null) {
    const middle = y + LINE / 2;
    legend.ramp.colors.forEach((fill, i) => {
      ops.push({
        kind: "rect",
        x: x + i * SWATCH,
        y: middle - SWATCH / 2,
        width: SWATCH,
        height: SWATCH,
        fill,
      });
    });
    text(x + legend.ramp.colors.length * SWATCH + 6, middle + TEXT_SIZE * MIDDLE, legend.ramp.text);
    y += LINE;
  }
  for (const note of legend.notes) {
    text(x, y + LINE / 2 + TEXT_SIZE * MIDDLE, note);
    y += LINE;
  }
  return { ops, height: y - top };
}

/**
 * The page of a picture: the caption on top, the drawing (cut at the panel's edges for the
 * visible part), the legend and the note under it. The page is as wide as the drawing, and a
 * little wider where the caption needs it; the drawing is then centred.
 */
export function composePicture(
  scene: FramedScene,
  parts: PictureParts,
  measure: MeasureAt,
): Picture {
  const color = scene.colors.text;
  const layers: Layer[] = [];
  const wanted = [
    scene.width,
    MIN_WIDTH,
    ...(parts.caption === null
      ? []
      : [
          measure(parts.caption.title, TITLE_SIZE, true),
          ...parts.caption.lines.map((line) => measure(line, TEXT_SIZE, false)),
        ].map((w) => Math.min(MAX_TEXT_WIDTH, w + 2 * PAGE_PADDING))),
    ...(parts.note === null
      ? []
      : [Math.min(MAX_TEXT_WIDTH, measure(parts.note, TEXT_SIZE, false) + 2 * PAGE_PADDING)]),
  ];
  const width = Math.ceil(Math.max(...wanted));
  const inner = width - 2 * PAGE_PADDING;
  let y = 0;
  if (parts.caption !== null) {
    const ops: Op[] = [];
    y += PAGE_PADDING;
    ops.push({
      kind: "text",
      x: PAGE_PADDING,
      y: y + TITLE_SIZE,
      text: parts.caption.title,
      size: TITLE_SIZE,
      fill: color,
      bold: true,
      anchor: "start",
      width: measure(parts.caption.title, TITLE_SIZE, true),
    });
    y += TITLE_SIZE + 6;
    for (const line of parts.caption.lines) {
      ops.push({
        kind: "text",
        x: PAGE_PADDING,
        y: y + TEXT_SIZE,
        text: line,
        size: TEXT_SIZE,
        fill: color,
        bold: false,
        anchor: "start",
        width: measure(line, TEXT_SIZE, false),
      });
      y += LINE;
    }
    y += 4;
    layers.push({ name: "caption", clip: null, ops });
  }
  const dx = (width - scene.width) / 2;
  layers.push({
    name: "graph",
    clip: scene.clipped ? { x: dx, y, width: scene.width, height: scene.height } : null,
    ops: graphOps(scene, dx, y, parts.background, measure),
  });
  y += scene.height;
  const under: Op[] = [];
  if (parts.legend !== null) {
    y += 4;
    const legend = legendOps(parts.legend, PAGE_PADDING, y, inner, color, measure);
    under.push(...legend.ops);
    y += legend.height;
  }
  if (parts.note !== null) {
    y += 4;
    under.push({
      kind: "text",
      x: PAGE_PADDING,
      y: y + TEXT_SIZE,
      text: parts.note,
      size: TEXT_SIZE,
      fill: color,
      bold: false,
      anchor: "start",
      width: measure(parts.note, TEXT_SIZE, false),
    });
    y += LINE;
  }
  if (under.length > 0) {
    layers.push({ name: "legend", clip: null, ops: under });
    y += PAGE_PADDING - 4;
  }
  return {
    width,
    height: Math.ceil(y),
    background: parts.background,
    font: scene.font,
    boldWeight: scene.boldWeight,
    title: parts.title,
    layers,
  };
}
