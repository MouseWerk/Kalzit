import { GRAPH_COLORS } from "./model";

/**
 * Theme colors for the WebGL renderer, which cannot read CSS variables: hidden probe elements
 * carry the tokens (graph.css), their computed colors are turned into `#rrggbb` through a 2D
 * canvas (the renderer parses hex and rgb, not oklch), and everything is read again when the
 * theme changes.
 */

export interface GraphPalette {
  /** `--chart-1` ... `--chart-8`. */
  series: string[];
  /** The same, mixed most of the way into the background, for what selection leaves out. */
  dimmed: string[];
  neutral: string;
  neutralDimmed: string;
  edge: string;
  edgeDimmed: string;
  text: string;
  background: string;
  /** `--bg-active`: the quiet tint behind the label of a selected node. */
  selection: string;
  /** Five steps per scheme (`--ramp-*`), for colors by a number property; and dimmed. */
  ramps: Record<RampName, string[]>;
  dimmedRamps: Record<RampName, string[]>;
  font: string;
  boldWeight: string;
}

export const RAMPS = ["blues", "gyr", "grays"] as const;
export type RampName = (typeof RAMPS)[number];
export const RAMP_STEPS = 5;

/** How far a dimmed color moves toward the background. */
const DIM = 0.78;
/** With forced colors (Windows high contrast) dimmed nodes and edges stay plainly visible. */
const FORCED_DIM = 0.5;

type Rgb = [number, number, number];

let scratch: CanvasRenderingContext2D | null | undefined;

/** A CSS color as RGB, through a 1x1 canvas; null where there is no canvas. */
export function toRgb(color: string): Rgb | null {
  if (scratch === undefined) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      scratch = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      scratch = null;
    }
  }
  if (scratch === null || color === "") {
    return null;
  }
  scratch.clearRect(0, 0, 1, 1);
  scratch.fillStyle = "#000";
  scratch.fillStyle = color;
  scratch.fillRect(0, 0, 1, 1);
  const [r, g, b] = scratch.getImageData(0, 0, 1, 1).data;
  return [r ?? 0, g ?? 0, b ?? 0];
}

export function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** `color` moved `amount` of the way toward `toward`. */
export function mix(color: Rgb, toward: Rgb, amount: number): Rgb {
  return [0, 1, 2].map(
    (i) => (color[i] as number) + ((toward[i] as number) - (color[i] as number)) * amount,
  ) as Rgb;
}

/** Reads the palette from the probes inside `root`. */
export function readPalette(root: HTMLElement): GraphPalette {
  const probe = (name: string) => {
    const element = root.querySelector<HTMLElement>(`.graph__probe--${name}`);
    return element === null ? "" : getComputedStyle(element).color;
  };
  const rgb = (name: string, fallback: Rgb): Rgb => toRgb(probe(name)) ?? fallback;
  const dim =
    typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches
      ? FORCED_DIM
      : DIM;
  const background = rgb("bg", [255, 255, 255]);
  const series = Array.from({ length: GRAPH_COLORS }, (_, i) => rgb(`${i + 1}`, [102, 102, 102]));
  const neutral = rgb("neutral", [120, 120, 120]);
  const edge = rgb("edge", [170, 170, 170]);
  const style = getComputedStyle(root);
  const ramp = (name: RampName) =>
    Array.from({ length: RAMP_STEPS }, (_, i) => rgb(`${name}-${i + 1}`, [120, 120, 120]));
  const ramps = Object.fromEntries(RAMPS.map((name) => [name, ramp(name)])) as Record<
    RampName,
    [number, number, number][]
  >;
  return {
    series: series.map(hex),
    dimmed: series.map((c) => hex(mix(c, background, dim))),
    neutral: hex(neutral),
    neutralDimmed: hex(mix(neutral, background, dim)),
    edge: hex(edge),
    edgeDimmed: hex(mix(edge, background, dim)),
    text: hex(rgb("text", [0, 0, 0])),
    background: hex(background),
    selection: hex(rgb("active", [230, 230, 230])),
    ramps: Object.fromEntries(RAMPS.map((n) => [n, ramps[n].map(hex)])) as Record<
      RampName,
      string[]
    >,
    dimmedRamps: Object.fromEntries(
      RAMPS.map((n) => [n, ramps[n].map((c) => hex(mix(c, background, dim)))]),
    ) as Record<RampName, string[]>,
    font: style.fontFamily || "sans-serif",
    boldWeight: style.getPropertyValue("--font-weight-semibold").trim() || "600",
  };
}

/** Canvases read their colors again when the theme, the color scheme or forced colors change. */
export { useThemeVersion } from "../useThemeVersion";

/** Whether the user asked for less motion; camera moves and the settling layout then jump. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
