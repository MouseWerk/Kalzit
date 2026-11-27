import type { GraphPalette } from "../colors";
import type { StyleColor } from "./schema";

/**
 * A rule's color as the renderer draws it: the data palette, the neutral and the text color, and
 * the status tones, each from the theme (never a literal, never the accent). `lit` false gives
 * the color of what a selection leaves out.
 */
export function ruleColor(palette: GraphPalette, color: StyleColor, lit = true): string {
  switch (color) {
    case "neutral":
      return lit ? palette.neutral : palette.neutralDimmed;
    case "neutral-strong":
      return lit ? palette.text : palette.neutralDimmed;
    case "good":
    case "warning":
    case "critical": {
      const tones = lit ? palette.tones : palette.tonesDimmed;
      if (tones !== undefined) return tones[color];
      // A palette without the tones: the green, yellow and red ends of the ramp.
      const step = color === "good" ? 0 : color === "warning" ? 2 : 4;
      return (lit ? palette.ramps : palette.dimmedRamps).gyr[step] ?? palette.neutral;
    }
    default: {
      const index = Number(color.slice("chart-".length)) - 1;
      return (lit ? palette.series : palette.dimmed)[index] ?? palette.neutral;
    }
  }
}

/** Whether the system forces its own colors: rule colors then drop out, the other cues stay. */
export function forcedColors(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(forced-colors: active)").matches
  );
}
