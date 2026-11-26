import { type GraphPalette, RAMP_STEPS, RAMPS, readPalette } from "../colors";
import { GRAPH_COLORS } from "../model";
import "../graph.css";
import "./graphExport.css";

/**
 * The panel's palette in the light color scheme, whatever scheme the page is in, for a picture
 * with a light background: the design tokens are `light-dark()` pairs, so probe elements under
 * `color-scheme: light` (graphExport.css) resolve to their light values. Read the way the panel
 * reads its own palette (colors.ts), from probes put into the panel for a moment.
 */
export function lightPalette(root: HTMLElement): GraphPalette {
  const probes = document.createElement("div");
  probes.className = "graph__probes graph-export__light";
  probes.setAttribute("aria-hidden", "true");
  const names = [
    ...Array.from({ length: GRAPH_COLORS }, (_, i) => `${i + 1}`),
    ...RAMPS.flatMap((ramp) => Array.from({ length: RAMP_STEPS }, (_, i) => `${ramp}-${i + 1}`)),
    "neutral",
    "edge",
    "text",
    "bg",
    "active",
  ];
  for (const name of names) {
    const probe = document.createElement("span");
    probe.className = `graph__probe graph__probe--${name}`;
    probes.append(probe);
  }
  root.append(probes);
  try {
    return readPalette(probes);
  } finally {
    probes.remove();
  }
}

/** Every color of a palette in a fixed order, so two palettes can be matched place by place. */
export function paletteColors(palette: GraphPalette): string[] {
  return [
    ...palette.series,
    ...palette.dimmed,
    palette.neutral,
    palette.neutralDimmed,
    palette.edge,
    palette.edgeDimmed,
    palette.text,
    palette.background,
    palette.selection,
    ...RAMPS.flatMap((name) => palette.ramps[name]),
    ...RAMPS.flatMap((name) => palette.dimmedRamps[name]),
  ];
}

/** The first family of a CSS font list, without its quotes: the font labels are drawn in. */
export function firstFamily(fonts: string): string {
  const first = fonts.split(",")[0] ?? "";
  return first.trim().replace(/^["']|["']$/g, "");
}
