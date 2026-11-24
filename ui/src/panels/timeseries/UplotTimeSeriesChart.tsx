import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import {
  backward,
  drawable,
  forward,
  logTicks,
  type ScaleSpec,
  softRange,
  symlogTicks,
  valueScale,
} from "../axisScale";
import { TONES, type Tone } from "../fieldConfig/fieldConfig";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import { useThemeVersion } from "../useThemeVersion";
import { type ChartData, chartData } from "./align";
import type { AxisKey, AxisPlan } from "./axes";
import {
  ChartShell,
  chartAxes,
  type PlotArea,
  SERIES_COLORS,
  type TimeSeriesChartProps,
} from "./ChartShell";
import {
  PX_PER_TIME_TICK,
  PX_PER_VALUE_TICK,
  TIME_LABEL_OVERHANG,
  VALUE_AXIS_SIZE,
  valueAxisSize,
} from "./layout";
import {
  FREE_CLASS,
  MONO_CLASS,
  MONO_COMPARE_CLASS,
  RAMP_CLASSES,
  type StackedData,
  styleKey,
} from "./styles";
import { type Paint, thresholdHooks, uplotSeries } from "./uplotSeries";
import "../panels.css";

/** The palette, monochrome and tone classes, one probe each. */
const SERIES_CLASSES = [
  ...Array.from({ length: SERIES_COLORS }, (_, i) => `series-${i + 1}`),
  MONO_CLASS,
  MONO_COMPARE_CLASS,
  ...RAMP_CLASSES,
  ...TONES.map((tone) => `tone--${tone}`),
];

const DAY = 24 * 60 * 60 * 1000;

/** The computed color of a probe element: tokens resolved to what a canvas understands. */
function probeColor(root: HTMLElement, selector: string): string {
  const probe = root.querySelector<HTMLElement>(selector);
  return probe === null ? "" : getComputedStyle(probe).color;
}

/** A number token read from the probes, or the fallback where it is not set (tests). */
function probeNumber(root: HTMLElement, name: string, fallback: number): number {
  const value = Number.parseFloat(getComputedStyle(root).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

/** Whether forced colors (Windows high contrast) are on. */
function forcedColors(): boolean {
  return (
    typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches
  );
}

function CursorLine({ x }: { x: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useStyleVars(ref, { "--cursor-x": `${x}px` });
  return <div className="ts__cursor-line" ref={ref} aria-hidden="true" />;
}

const EMPTY_STACK: StackedData = {
  ys: [],
  baselines: [],
  percent: false,
};

/** The data as uPlot takes it; values a log axis cannot draw (<= 0) become gaps. */
function aligned(
  data: ChartData,
  axes: readonly AxisPlan[],
  axisOf: readonly AxisKey[],
): uPlot.AlignedData {
  const ys = data.stacked.ys.map((values, index) => {
    const kind = axes.find((a) => a.key === axisOf[index])?.spec.scale ?? "linear";
    return kind === "log"
      ? values.map((v) => (v === null || !drawable(kind, v) ? null : v))
      : values;
  });
  return [data.x, ...ys] as uPlot.AlignedData;
}

/** Room for an axis label turned along the axis, in px. */
const TITLE_SIZE = 16;

/** What a built chart depends on of its axes; the rest reaches it through `live`. */
function axesKey(axes: readonly AxisPlan[], axisOf: readonly AxisKey[]): string {
  return JSON.stringify([
    axes.map((a) => [
      a.key,
      a.show,
      a.spec.scale,
      a.spec.base,
      a.label ?? "",
      a.width ?? 0,
      a.grid,
      a.color,
      a.line,
      a.series[0] ?? 0,
    ]),
    axisOf,
  ]);
}

/**
 * A value scale's range: on a linear scale uPlot's own rounding of the data, widened by the soft
 * limits and centered on zero where asked; on the log scales the shared math (`axisScale.ts`).
 * Fixed ends stay exactly.
 */
function scaleRange(
  spec: ScaleSpec,
  dataMin: number | null,
  dataMax: number | null,
): uPlot.Range.MinMax {
  const extent =
    dataMin === null || dataMax === null || !Number.isFinite(dataMin) || !Number.isFinite(dataMax)
      ? null
      : { min: dataMin, max: dataMax };
  if (spec.scale !== "linear") {
    const scale = valueScale(extent, spec, 5);
    return [scale.min, scale.max];
  }
  const wide = softRange(extent, spec) ?? { min: 0, max: 1 };
  let [min, max] = uPlot.rangeNum(wide.min, wide.max, 0.1, true);
  if (spec.centeredZero === true) {
    const reach = Math.max(Math.abs(min ?? 0), Math.abs(max ?? 0));
    min = -reach;
    max = reach;
  }
  return [spec.min ?? min, spec.max ?? max];
}

/**
 * The time series drawn by uPlot on a canvas, which stays fast with 100,000 points and more.
 * Loaded lazily with the time series panel. Colors come from the theme tokens (`--chart-1` to
 * `--chart-8`, `--chart-mono`, text and border), read through hidden probe elements; each
 * series is drawn as its style says (`uplotSeries.ts`).
 */
export function UplotTimeSeriesChart({
  series,
  styles,
  timeRange,
  title,
  legend,
  tooltip,
  format,
  axes: givenAxes,
  axisOf: givenAxisOf,
  axisFormat,
  note,
}: TimeSeriesChartProps) {
  const { language, timeZone } = useI18n();
  const { axes, axisOf } = chartAxes({ series, styles, axes: givenAxes, axisOf: givenAxisOf });
  const boxRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const probesRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  // The stacked data the chart draws; stacked bars read their baselines from it when drawn.
  const stackRef = useRef<StackedData>(EMPTY_STACK);
  const { width, height } = useElementSize(boxRef);
  const themeVersion = useThemeVersion();
  const [plot, setPlot] = useState<PlotArea>({ left: VALUE_AXIS_SIZE, width: 1 });
  // Counts charts built, so the size effect also runs for a chart built after the last resize.
  const [built, setBuilt] = useState(0);
  // What the chart's callbacks read when they run: new data, a new range or new value bounds
  // reach a built chart through setData instead of a new chart.
  const live = useRef({ timeRange, axes, axisFormat });
  useLayoutEffect(() => {
    live.current = { timeRange, axes, axisFormat };
  });
  // A new chart only when what it is built from changes: the series' names and styles (colors,
  // draw style, fills, stacking), language, time zone and theme. Data alone goes through setData.
  const structure = `${series.map((s) => s.name).join("\u0000")}\n${styleKey(styles)}\n${axesKey(axes, axisOf)}`;
  const scales = `${timeRange.from},${timeRange.to},${JSON.stringify(axes.map((a) => a.spec))}`;
  const builtFor = useRef<{
    series: readonly unknown[];
    scales: string;
    axisFormat: TimeSeriesChartProps["axisFormat"];
  } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the chart is built from `structure`; themeVersion only triggers a redraw
  useLayoutEffect(() => {
    const target = targetRef.current;
    const probes = probesRef.current;
    if (target === null || probes === null) {
      return;
    }
    const axis = probeColor(probes, ".ts__probe--axis");
    const grid = probeColor(probes, ".ts__probe--grid");
    const borderColor = probeColor(probes, ".ts__probe--line");
    const font = `${getComputedStyle(probes).fontSize} ${getComputedStyle(probes).fontFamily}`;
    const forced = forcedColors();
    const tones: Partial<Record<Tone, string>> = {};
    for (const tone of TONES) {
      tones[tone] = probeColor(probes, `.tone--${tone}`);
    }
    // The hatch and the fade come from the tokens the SVG chart uses too, so the two never drift.
    const hatchAlpha = probeNumber(probes, "--chart-hatch-alpha", 0.5);
    const hatchWidth = probeNumber(probes, "--chart-hatch-width", 1);
    const hatchSpacing = probeNumber(probes, "--chart-hatch-spacing", 6);
    const fadeTo = probeNumber(probes, "--chart-fade-to", 0.15);
    const bandAlpha = probeNumber(probes, "--chart-threshold-alpha", 0.12);
    // Time labels in the UI language: dates for steps of a day or more, else hours and minutes.
    // Ticks and labels on the wall clock of the user's time zone.
    const zone = zoneOption(timeZone);
    const dates = new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit", ...zone });
    const times = new Intl.DateTimeFormat(language, {
      hour: "2-digit",
      minute: "2-digit",
      ...zone,
    });
    // Faint horizontal grid lines only, no tick marks: the values carry the axis.
    const axisStyle = { stroke: axis, font, ticks: { show: false } };
    const data = chartData(series, styles);
    stackRef.current = data.stacked;
    const options: uPlot.Options = {
      width: Math.max(width, 10),
      height: Math.max(height, 10),
      ms: 1,
      ...(timeZone === null
        ? {}
        : { tzDate: (ts: number) => uPlot.tzDate(new Date(ts), timeZone) }),
      legend: { show: false },
      hooks: thresholdHooks(styles, { tones, color: probeColor(probes, ".series-1") }, bandAlpha),
      // The shell draws the cursor and the readout, the same for keyboard and pointer.
      cursor: { show: false },
      // top, right, bottom, left; null keeps uPlot's own spacing.
      padding: [null, TIME_LABEL_OVERHANG, null, null],
      scales: {
        // The panel's time range, read when the scale is set (also after setData).
        x: {
          time: true,
          range: () => [live.current.timeRange.from, live.current.timeRange.to],
        },
        // Each value axis: its distribution and its range, read when the scale is set.
        ...Object.fromEntries(
          axes.map((plan): [string, uPlot.Scale] => {
            const { scale: kind, base } = plan.spec;
            const current = () =>
              live.current.axes.find((a) => a.key === plan.key)?.spec ?? plan.spec;
            return [
              plan.key,
              {
                ...(kind === "linear"
                  ? {}
                  : {
                      distr: 100,
                      fwd: (v: number) => forward(kind, base, v),
                      bwd: (v: number) => backward(kind, base, v),
                    }),
                range: (_u, dataMin, dataMax) => scaleRange(current(), dataMin, dataMax),
              },
            ];
          }),
        ),
      },
      axes: [
        {
          ...axisStyle,
          grid: { show: false },
          space: PX_PER_TIME_TICK,
          values: (_u, splits, _axis, _space, step) =>
            splits.map((v) => (step >= DAY ? dates : times).format(v)),
        },
        ...axes.map((plan): uPlot.Axis => {
          const first = plan.series[0] ?? 0;
          const stroke =
            plan.color === "series"
              ? probeColor(probes, `.${styles[first]?.colorClass ?? "series-1"}`)
              : axis;
          const title = plan.label === undefined ? 0 : TITLE_SIZE;
          return {
            ...axisStyle,
            stroke,
            scale: plan.key,
            side: plan.side === "left" ? 3 : 1,
            show: plan.show,
            grid: { show: plan.grid, stroke: grid, width: 1 },
            border: { show: plan.line, stroke: borderColor, width: 1 },
            ...(plan.label === undefined
              ? {}
              : { label: plan.label, labelSize: TITLE_SIZE, labelFont: font, labelGap: 0 }),
            size: (_u, values) => (plan.width ?? valueAxisSize(values, font)) + title,
            ...(plan.spec.scale === "linear"
              ? {}
              : {
                  // Ticks at the powers of the base (and zero around zero).
                  splits: (u: uPlot) => {
                    const range = u.scales[plan.key];
                    const ticks = plan.spec.scale === "log" ? logTicks : symlogTicks;
                    return ticks(
                      plan.spec.base,
                      range?.min ?? 1,
                      range?.max ?? 10,
                      Math.max(2, Math.floor(u.bbox.height / uPlot.pxRatio / PX_PER_VALUE_TICK)),
                    );
                  },
                }),
            values: (_u, values) => values.map((v) => live.current.axisFormat(v, plan.key)),
          };
        }),
      ],
      series: [
        {},
        ...series.map((s, index) => {
          const style = styles[index];
          const paint: Paint = {
            // A free colour is used as it is; the others come from the theme through the probes.
            // With forced colors a free colour gives way to the system color of its position.
            color:
              style?.colorClass === FREE_CLASS && style.freeColor !== null
                ? forced
                  ? probeColor(probes, `.series-${(index % SERIES_COLORS) + 1}`)
                  : style.freeColor
                : probeColor(probes, `.${style?.colorClass ?? "series-1"}`),
            tones,
            hatchAlpha,
            hatchWidth,
            hatchSpacing,
            fadeTo,
          };
          const scale = axisOf[index] ?? "y";
          return style === undefined
            ? { label: s.name, scale }
            : { ...uplotSeries(s.name, index, style, paint, stackRef), scale };
        }),
      ],
    };
    const chart = new uPlot(options, aligned(data, axes, axisOf), target);
    chartRef.current = chart;
    builtFor.current = { series, scales, axisFormat };
    setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
    setBuilt((count) => count + 1);
    return () => {
      chart.destroy();
      chartRef.current = null;
      builtFor.current = null;
    };
  }, [structure, language, timeZone, themeVersion]);

  // New data, range, value bounds or axis labels for the chart that stands: setData redraws it
  // in place (the scales read the range and bounds through `live`).
  useLayoutEffect(() => {
    const chart = chartRef.current;
    const made = builtFor.current;
    if (chart === null || made === null) {
      return;
    }
    if (made.series === series && made.scales === scales && made.axisFormat === axisFormat) {
      return;
    }
    builtFor.current = { series, scales, axisFormat };
    if (made.series === series) {
      chart.setData(chart.data);
    } else {
      const data = chartData(series, styles);
      stackRef.current = data.stacked;
      chart.setData(aligned(data, live.current.axes, axisOf));
    }
    setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
  }, [series, scales, axisFormat, styles, axisOf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `built` stands for a new chart
  useEffect(() => {
    const chart = chartRef.current;
    if (chart !== null && (chart.width !== width || chart.height !== height)) {
      chart.setSize({ width: Math.max(width, 10), height: Math.max(height, 10) });
      setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
    }
  }, [width, height, built]);

  return (
    <ChartShell
      series={series}
      styles={styles}
      title={title}
      legend={legend}
      tooltip={tooltip}
      format={format}
      note={note}
      boxRef={boxRef}
      plot={plot}
      timeAt={(x) =>
        chartRef.current?.posToVal(x - plot.left, "x") ??
        timeRange.from + ((x - plot.left) / plot.width) * (timeRange.to - timeRange.from)
      }
      valueAt={(y) => chartRef.current?.posToVal(y, axes[0]?.key ?? "y") ?? Number.NaN}
    >
      {(cursorX) => (
        <>
          <div className="ts__uplot" ref={targetRef} aria-hidden="true" />
          <div className="ts__probes" ref={probesRef} aria-hidden="true">
            <span className="ts__probe ts__probe--axis" />
            <span className="ts__probe ts__probe--grid" />
            <span className="ts__probe ts__probe--line" />
            {SERIES_CLASSES.map((name) => (
              <span key={name} className={`ts__probe ${name}`} />
            ))}
          </div>
          {cursorX === null ? null : <CursorLine x={cursorX} />}
        </>
      )}
    </ChartShell>
  );
}
