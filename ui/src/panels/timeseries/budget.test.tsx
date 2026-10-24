import { render } from "@testing-library/react";
import uPlot from "uplot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../../api/generated/shapes";
import type { FieldConfig, FieldOptions } from "../fieldConfig/fieldConfig";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { chartData } from "./align";
import { buildSeries } from "./series";
import { resolveStyles } from "./styles";
import { uplotSeries } from "./uplotSeries";

/**
 * Performance budget of the graph styles (design: quality/performance.md), in the pattern of the
 * panels' budgets: 100,000 points per style, the best of a few runs, CI runners get more time.
 * Timed is the script work that grows with the points: building and stacking the series,
 * uPlot's own path builders (line, smooth, steps, bars, points, gap refinement) and the fills
 * (gradients, the hatch tile) through a recording 2D context. jsdom has no canvas, so nothing is
 * rasterized here: paths go into a Path2D that records nothing. Drawing the hatched, gradient
 * and stacked charts on a real canvas is timed in Chromium by `ui/e2e/budget.spec.ts`.
 */
// uPlot reads the device pixel ratio through matchMedia when it loads; jsdom has none.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

const CI = process.env.CI !== undefined;
const POINTS = 100_000;
const PLOT = { left: 0, top: 0, width: 1000, height: 300 };

class RecordingPath {
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  rect() {}
  arc() {}
  closePath() {}
  addPath() {}
}

beforeEach(() => {
  vi.stubGlobal("Path2D", RecordingPath);
});

function frame(count: number): Frame {
  const time = Array.from({ length: count }, (_, i) => i * 1000);
  const wave = (shift: number) =>
    Array.from({ length: POINTS }, (_, i) =>
      // A gap every 1,000 points, so gap handling has work to do.
      i % 1000 === 999 ? null : Math.sin(i / 500 + shift) * 100 + 120 + (i % 7),
    );
  return {
    fields: [
      { name: "time", type: "time", values: time },
      { name: "a", type: "number", values: wave(0) },
      { name: "b", type: "number", values: wave(1) },
    ],
  };
}

const big = frame(POINTS);

function minOf(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    work();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** What uPlot's path builders read of a chart, for one draw over the whole range. */
function chartFor(data: uPlot.AlignedData, series: uPlot.Series[]): uPlot {
  const x = data[0] as number[];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const ys of data.slice(1)) {
    for (const y of ys as (number | null)[]) {
      if (y !== null && y < min) min = y;
      if (y !== null && y > max) max = y;
    }
  }
  const scales = {
    x: { key: "x", ori: 0, dir: 1, distr: 1, min: x[0] as number, max: x.at(-1) as number },
    y: { key: "y", ori: 1, dir: 1, distr: 1, min, max },
  };
  type Scale = (typeof scales)["x"];
  const posH = (v: number, s: Scale, dim: number, off: number) =>
    off + ((v - s.min) / (s.max - s.min)) * dim;
  const posV = (v: number, s: Scale, dim: number, off: number) =>
    off + dim - ((v - s.min) / (s.max - s.min)) * dim;
  const round = (v: number) => Math.round(v);
  return {
    mode: 1,
    data,
    _data: data,
    bbox: PLOT,
    bands: [],
    scales,
    series: [
      { scale: "x" },
      ...series.map((s) => ({
        ...s,
        scale: "y",
        pxRound: round,
        fillTo: () => 0,
        gaps: s.gaps ?? ((_u: unknown, _i: number, _a: number, _b: number, gaps: unknown) => gaps),
        points: { size: 5, width: 0, ...s.points },
      })),
    ],
    valToPosH: posH,
    valToPosV: posV,
    valToPos: (v: number, key: "x" | "y") =>
      key === "x" ? posH(v, scales.x, PLOT.width, 0) : posV(v, scales.y, PLOT.height, 0),
    posToVal: (pos: number, key: "x" | "y") => {
      const s = scales[key];
      return s.min + (pos / PLOT.width) * (s.max - s.min);
    },
  } as unknown as uPlot;
}

const STYLES: [name: string, options: FieldOptions][] = [
  ["line", { lineInterpolation: "linear" }],
  ["smooth line", { lineInterpolation: "smooth" }],
  ["steps", { lineInterpolation: "stepAfter" }],
  ["dashed line with hatch", { lineStyle: "dashed", fill: "hatch", gradientMode: "opacity" }],
  ["solid fill with gradient", { fill: "solid", gradientMode: "hue" }],
  ["bars", { drawStyle: "bars" }],
  ["stacked bars", { drawStyle: "bars", stack: "normal" }],
  ["points", { drawStyle: "points" }],
  ["stacked to 100 %", { stack: "percent", fill: "solid" }],
  ["gaps bridged up to 5 s", { connectGaps: "threshold", connectGapsBelow: 5000 }],
  ["break after 2 s", { connectGaps: "always", breakAfter: 2000 }],
];

/**
 * A 2D context that records what is asked of it: gradients and patterns are made for real by the
 * fill code (its color stops, the hatch tile's lines), only nothing is rasterized.
 */
function recordingContext(height: number) {
  const calls = { gradients: 0, patterns: 0, strokes: 0 };
  const context = {
    canvas: { height },
    lineWidth: 1,
    strokeStyle: "" as unknown,
    createLinearGradient: () => {
      calls.gradients++;
      return { addColorStop: () => undefined };
    },
    createPattern: () => {
      calls.patterns++;
      return {};
    },
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => {
      calls.strokes++;
    },
  };
  return { context, calls };
}

describe("budget: 100,000 points per graph style", () => {
  it.each(STYLES)(
    "builds the paths, fills and hatch of %s within budget (no rasterizing in jsdom)",
    (name, options) => {
      const config: FieldConfig = { defaults: options, overrides: [] };
      const paint = {
        color: "oklch(0.92 0.004 286)",
        tones: {},
        hatchAlpha: 0.5,
        hatchWidth: 1,
        hatchSpacing: 6,
        fadeTo: 0.15,
      };
      const { context, calls } = recordingContext(PLOT.height);
      // The hatch tile is a canvas of its own.
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        () => recordingContext(PLOT.height).context as unknown as CanvasRenderingContext2D,
      );
      let drawn = 0;
      let fills = 0;
      const ms = minOf(3, () => {
        const series = buildSeries([big], "", config);
        const styles = resolveStyles(series);
        const data = chartData(series, styles);
        const ref = { current: data.stacked };
        const options = series.map((s, i) =>
          uplotSeries(s.name, i, styles[i] as (typeof styles)[number], paint, ref),
        );
        const chart = chartFor([data.x, ...data.stacked.ys] as uPlot.AlignedData, options);
        Object.assign(chart, { ctx: context });
        drawn = 0;
        fills = 0;
        options.forEach((s, i) => {
          const paths = s.paths?.(chart, i + 1, 0, POINTS - 1);
          if (paths !== null && paths !== undefined) drawn++;
          if (styles[i]?.showPoints === "always") {
            uPlot.paths.points?.()(chart, i + 1, 0, POINTS - 1);
            drawn++;
          }
          // Two draws of the same plot: the second takes the kept fill.
          if (typeof s.fill === "function") {
            s.fill(chart, i + 1);
            s.fill(chart, i + 1);
            fills++;
          }
        });
      });
      process.stdout.write(
        `time series: 100k points as ${name}: paths and fills in ${ms.toFixed(1)} ms\n`,
      );
      expect(drawn).toBe(2);
      // A filled style made its gradient or pattern once per series and run, not per draw.
      const filled =
        options.fill !== undefined || options.stack !== undefined || options.drawStyle === "bars";
      if (filled) {
        expect(fills).toBe(2);
        expect(calls.gradients + calls.patterns).toBeLessThanOrEqual(3 * 2 * 2);
      }
      expect(ms).toBeLessThan(CI ? 300 : 120);
    },
  );

  it.each(STYLES)("renders the SVG fallback panel for %s within budget", (_name, options) => {
    const plugin = getPanel("timeseries") as AnyPanelPlugin;
    const { Panel } = plugin;
    const config: FieldConfig = { defaults: options, overrides: [] };
    const ms = minOf(3, () => {
      const { unmount } = render(
        <Panel
          frames={[big]}
          options={plugin.options({})}
          fieldConfig={config}
          timeRange={{ from: 0, to: POINTS * 1000 }}
          title="Panel"
        />,
      );
      unmount();
    });
    expect(ms).toBeLessThan(CI ? 600 : 250);
  });
});
