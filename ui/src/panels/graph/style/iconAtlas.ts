import { iconsNow } from "./icons/load";

/**
 * The texture the renderer reads node icons from: one canvas for the page, a cell per icon,
 * drawn the first time a rule uses the icon. Icons are stroked from their path data with the 2D
 * canvas (`Path2D`), so nothing is fetched and no markup is made: the content security policy
 * needs no exception. Only the coverage is kept (the alpha of the texture); the color comes from
 * the theme at draw time.
 */

/** The edge of a cell in texture pixels, and of the icon inside it (the rest is clear margin). */
export const ATLAS_CELL = 64;
const ATLAS_INNER = 52;
const COLUMNS = 24;
const ROWS = 16;
export const ATLAS_WIDTH = COLUMNS * ATLAS_CELL;
export const ATLAS_HEIGHT = ROWS * ATLAS_CELL;

/** Where an icon lies in the texture: left, top, width and height as shares of its size. */
export type IconRect = readonly [number, number, number, number];
export const NO_ICON: IconRect = [0, 0, 0, 0];

interface Atlas {
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  slots: Map<string, IconRect>;
  /** Counts every icon drawn: the renderer uploads the canvas again when it differs. */
  version: number;
}

let atlas: Atlas | undefined;

function ensure(): Atlas {
  if (atlas !== undefined) return atlas;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  try {
    if (typeof document !== "undefined" && typeof Path2D !== "undefined") {
      canvas = document.createElement("canvas");
      canvas.width = ATLAS_WIDTH;
      canvas.height = ATLAS_HEIGHT;
      context = canvas.getContext("2d");
    }
  } catch {
    context = null;
  }
  atlas = { canvas: context === null ? null : canvas, context, slots: new Map(), version: 0 };
  return atlas;
}

/**
 * The cell of an icon, drawn on first use. `NO_ICON` while the icon set has not loaded, for a
 * name the set lacks, and where the browser has no 2D canvas: the node then shows without one.
 */
export function iconRect(name: string): IconRect {
  const a = ensure();
  const known = a.slots.get(name);
  if (known !== undefined) return known;
  const set = iconsNow();
  const icon = set?.iconOf(name);
  if (set === null || icon === undefined || a.context === null) return NO_ICON;
  if (a.slots.size >= COLUMNS * ROWS) return NO_ICON;
  const slot = a.slots.size;
  const x = (slot % COLUMNS) * ATLAS_CELL;
  const y = Math.floor(slot / COLUMNS) * ATLAS_CELL;
  const context = a.context;
  const scale = ATLAS_INNER / set.ICON_GRID;
  const margin = (ATLAS_CELL - ATLAS_INNER) / 2;
  context.save();
  context.translate(x + margin, y + margin);
  context.scale(scale, scale);
  context.lineWidth = set.ICON_STROKE;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#fff";
  context.stroke(new Path2D(icon.d));
  context.restore();
  const rect: IconRect = [
    x / ATLAS_WIDTH,
    y / ATLAS_HEIGHT,
    ATLAS_CELL / ATLAS_WIDTH,
    ATLAS_CELL / ATLAS_HEIGHT,
  ];
  a.slots.set(name, rect);
  a.version++;
  return rect;
}

/** The atlas as the renderer uploads it: its canvas (null without one) and its version. */
export function atlasState(): { canvas: HTMLCanvasElement | null; version: number } {
  const a = ensure();
  return { canvas: a.canvas, version: a.version };
}

/** Forgets the atlas, for tests. */
export function resetAtlas(): void {
  atlas = undefined;
}
