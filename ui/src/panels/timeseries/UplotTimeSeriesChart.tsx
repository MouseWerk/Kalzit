import { useEffect, useLayoutEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { TONES } from "../fieldConfig/fieldConfig";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import { alignSeries } from "./align";
import {
  ChartShell,
  type PlotArea,
  SERIES_COLORS,
  seriesClass,
  type TimeSeriesChartProps,
} from "./ChartShell";
import { PX_PER_TIME_TICK, TIME_LABEL_OVERHANG } from "./layout";
import "../panels.css";

/** The palette and tone classes, one probe each. */
const SERIES_CLASSES = [
  ...Array.from({ length: SERIES_COLORS }, (_, i) => `series-${i + 1}`),
  ...TONES.map((tone) => `tone--${tone}`),
];

const DAY = 24 * 60 * 60 * 1000;

/** Width of the value axis in CSS pixels, enough for labels such as "-12.5k". */
const VALUE_AXIS_SIZE = 56;

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

function CursorLine({ x }: { x: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useStyleVars(ref, { "--cursor-x": `${x}px` });
  return <div className="ts__cursor-line" ref={ref} aria-hidden="true" />;
}

/**
 * The time series drawn by uPlot on a canvas, which stays fast with 100,000 points and more.
 * Loaded lazily with the time series panel. Colors come from the theme tokens (`--chart-1` to
 * `--chart-8`, text and border), read through hidden probe elements.
 */
export function UplotTimeSeriesChart({
  series,
  timeRange,
  title,
  lineWidth,
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
  // A new chart only when what it is built from changes: the series' names and colors, the line
  // width, language, time zone and theme. Data alone goes through setData.
  const structure = series.map((s, index) => `${s.name}\u0000${seriesClass(s, index)}`).join("\n");
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
    // Time labels in the UI language: dates for steps of a day or more, else hours and minutes.
    // Ticks and labels on the wall clock of the user's time zone.
    const zone = zoneOption(timeZone);
    const dates = new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit", ...zone });
    const times = new Intl.DateTimeFormat(language, {
      hour: "2-digit",
      minute: "2-digit",
      ...zone,
    });
    const axisStyle = {
      stroke: axis,
      font,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
    };
    const options: uPlot.Options = {
      width: Math.max(width, 10),
      height: Math.max(height, 10),
      ms: 1,
      ...(timeZone === null
        ? {}
        : { tzDate: (ts: number) => uPlot.tzDate(new Date(ts), timeZone) }),
      legend: { show: false },
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
          space: PX_PER_TIME_TICK,
          values: (_u, splits, _axis, _space, step) =>
            splits.map((v) => (step >= DAY ? dates : times).format(v)),
        },
        {
          ...axisStyle,
          size: VALUE_AXIS_SIZE,
          values: (_u, values) => values.map((v) => live.current.axisFormat(v)),
        },
      ],
      series: [
        {},
        ...series.map((s, index) => ({
          label: s.name,
          stroke: probeColor(probes, `.${seriesClass(s, index)}`),
          width: lineWidth,
          points: { show: false },
          spanGaps: false,
        })),
      ],
    };
    const chart = new uPlot(options, alignSeries(series) as uPlot.AlignedData, target);
    chartRef.current = chart;
    builtFor.current = { series, scales, axisFormat };
    setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
    setBuilt((count) => count + 1);
    return () => {
      chart.destroy();
      chartRef.current = null;
      builtFor.current = null;
    };
  }, [structure, lineWidth, language, timeZone, themeVersion]);

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
    const data = made.series === series ? chart.data : (alignSeries(series) as uPlot.AlignedData);
    builtFor.current = { series, scales, axisFormat };
    chart.setData(data);
    setPlot({ left: chart.bbox.left / uPlot.pxRatio, width: chart.bbox.width / uPlot.pxRatio });
  }, [series, scales, axisFormat]);

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
