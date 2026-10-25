import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { TONES, type Tone } from "../fieldConfig/fieldConfig";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import { type ChartData, chartData } from "./align";
import { ChartShell, type PlotArea, SERIES_COLORS, type TimeSeriesChartProps } from "./ChartShell";
import { PX_PER_TIME_TICK, TIME_LABEL_OVERHANG, VALUE_AXIS_SIZE, valueAxisSize } from "./layout";
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

/**
 * Re-reads theme colors when the theme changes: the data-theme attribute or the system's light
 * and dark preference. A canvas cannot use CSS variables, so the chart is drawn again.
 */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    media?.addEventListener("change", bump);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", bump);
    };
  }, []);
  return version;
}

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

function aligned(data: ChartData): uPlot.AlignedData {
  return [data.x, ...data.stacked.ys] as uPlot.AlignedData;
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
  axisFormat,
  yRange,
}: TimeSeriesChartProps) {
  const { language, timeZone } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const probesRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  // The stacked data the chart draws; stacked bars read their baselines from it when drawn.
  const stackRef = useRef<StackedData>(EMPTY_STACK);
  const yMin = yRange?.min;
  const yMax = yRange?.max;
  const { width, height } = useElementSize(boxRef);
  const themeVersion = useThemeVersion();
  const [plot, setPlot] = useState<PlotArea>({ left: VALUE_AXIS_SIZE, width: 1 });
  // Counts charts built, so the size effect also runs for a chart built after the last resize.
  const [built, setBuilt] = useState(0);
  // What the chart's callbacks read when they run: new data, a new range or new value bounds
  // reach a built chart through setData instead of a new chart.
  const live = useRef({ timeRange, yMin, yMax, axisFormat });
  useLayoutEffect(() => {
    live.current = { timeRange, yMin, yMax, axisFormat };
  });
  // A new chart only when what it is built from changes: the series' names and styles (colors,
  // draw style, fills, stacking), language, time zone and theme. Data alone goes through setData.
  const structure = `${series.map((s) => s.name).join("\u0000")}\n${styleKey(styles)}`;
  const scales = `${timeRange.from},${timeRange.to},${yMin ?? ""},${yMax ?? ""}`;
  const builtFor = useRef<{
    series: readonly unknown[];
    scales: string;
    axisFormat: (value: number) => string;
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
    const font = `${getComputedStyle(probes).fontSize} ${getComputedStyle(probes).fontFamily}`;
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
        // Fixed ends from the field options; uPlot's own range for the open ones.
        y: {
          range: (_u, dataMin, dataMax) => {
            const [min, max] = uPlot.rangeNum(dataMin, dataMax, 0.1, true);
            return [live.current.yMin ?? min, live.current.yMax ?? max];
          },
        },
      },
      axes: [
        {
          ...axisStyle,
          grid: { show: false },
          space: PX_PER_TIME_TICK,
          values: (_u, splits, _axis, _space, step) =>
            splits.map((v) => (step >= DAY ? dates : times).format(v)),
        },
        {
          ...axisStyle,
          grid: { stroke: grid, width: 1 },
          size: (_u, values) => valueAxisSize(values, font),
          values: (_u, values) => values.map((v) => live.current.axisFormat(v)),
        },
      ],
      series: [
        {},
        ...series.map((s, index) => {
          const style = styles[index];
          const paint: Paint = {
            // A free colour is used as it is; the others come from the theme through the probes.
            color:
              style?.colorClass === FREE_CLASS && style.freeColor !== null
                ? style.freeColor
                : probeColor(probes, `.${style?.colorClass ?? "series-1"}`),
            tones,
            hatchAlpha,
            hatchWidth,
            hatchSpacing,
            fadeTo,
          };
          return style === undefined
            ? { label: s.name }
            : uplotSeries(s.name, index, style, paint, stackRef);
        }),
      ],
    };
    const chart = new uPlot(options, aligned(data), target);
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
      chart.setData(aligned(data));
    }
    setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
  }, [series, scales, axisFormat, styles]);

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
      boxRef={boxRef}
      plot={plot}
      timeAt={(x) =>
        chartRef.current?.posToVal(x - plot.left, "x") ??
        timeRange.from + ((x - plot.left) / plot.width) * (timeRange.to - timeRange.from)
      }
      valueAt={(y) => chartRef.current?.posToVal(y, "y") ?? Number.NaN}
    >
      {(cursorX) => (
        <>
          <div className="ts__uplot" ref={targetRef} aria-hidden="true" />
          <div className="ts__probes" ref={probesRef} aria-hidden="true">
            <span className="ts__probe ts__probe--axis" />
            <span className="ts__probe ts__probe--grid" />
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
