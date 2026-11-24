import { lazy, type ReactNode, Suspense } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { usePanelAlertMarks } from "../alertMarks";
import { displayText, displayValue, EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { axisTickFormat } from "../fieldConfig/units";
import { legacyLineWidth, legacyUnit } from "../fieldConfig/upgrade";
import { TimeSeriesPreview } from "../picker/previews";
import { EmptyPanel, emptyReason, TextField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { chartData } from "./align";
import { type AxisKey, type AxisPlan, planAxes, skippedPoints } from "./axes";
import type { TimeSeriesChartProps } from "./ChartShell";
import { SvgTimeSeriesChart } from "./SvgTimeSeriesChart";
import { buildSeries } from "./series";
import { resolveStyles } from "./styles";
import { withAlertLimits } from "./thresholdBands";

/**
 * The panel's own options. How series are drawn (draw style, line, fill, points, gaps, stacking)
 * is a field option (`fieldConfig/graphStyle.ts`), so overrides can set it per series.
 */
export interface TimeSeriesOptions {
  /** Series names from labels, such as "{{job}} on {{instance}}"; empty uses the field names. */
  seriesName: string;
  legend: LegendOptions;
  tooltip: TooltipOptions;
  /** A unit typed before the field options existed; the field options' unit wins. */
  unit?: string;
  /** A line width chosen before the graph style; the field options' line width wins. */
  lineWidth?: number;
}

/** jsdom, where the tests run, has no canvas; there the SVG chart draws. */
const HAS_CANVAS = typeof navigator !== "undefined" && !/jsdom/i.test(navigator.userAgent);

// uPlot loads with the first time series, so the start bundle does not carry it.
const LazyUplotChart = lazy(() =>
  import("./UplotTimeSeriesChart").then((module) => ({ default: module.UplotTimeSeriesChart })),
);

/** uPlot draws the chart; the SVG chart shows meanwhile and where there is no canvas. */
function TimeSeriesChart(props: TimeSeriesChartProps): ReactNode {
  if (!HAS_CANVAS) {
    return <SvgTimeSeriesChart {...props} />;
  }
  return (
    <Suspense fallback={<SvgTimeSeriesChart {...props} />}>
      <LazyUplotChart {...props} />
    </Suspense>
  );
}

/** The line widths the panel's own option took before the graph style. */
const LEGACY_LINE_WIDTHS = [1, 2, 3] as const;

function parseOptions(stored: unknown): TimeSeriesOptions {
  const value = isRecord(stored) ? stored : {};
  const options: TimeSeriesOptions = {
    // Before the legend options, the series name template was stored under `legend`.
    seriesName:
      typeof value.seriesName === "string"
        ? value.seriesName
        : typeof value.legend === "string"
          ? value.legend
          : "",
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
  if (typeof value.unit === "string" && value.unit !== "") {
    options.unit = value.unit;
  }
  const lineWidth = LEGACY_LINE_WIDTHS.find((w) => w === value.lineWidth);
  if (lineWidth !== undefined) {
    options.lineWidth = lineWidth;
  }
  return options;
}

function TimeSeriesPanel({
  frames,
  options,
  timeRange,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<TimeSeriesOptions>) {
  const { t, language } = useI18n();
  const alert = usePanelAlertMarks();
  const config = legacyLineWidth(legacyUnit(fieldConfig, options.unit), options.lineWidth);
  const series = buildSeries(frames, options.seriesName, config);
  // An alert rule's limits are dashed lines, unless the panel draws thresholds of its own.
  const styles = withAlertLimits(resolveStyles(series), alert?.limits ?? []);
  // No rows in the range is one muted line, not an empty chart with axes and a legend.
  const reason = emptyReason(frames, "noTimeSeries");
  if (series.length === 0 || reason === "noData") {
    return <EmptyPanel reason={reason} />;
  }
  // Each value axis follows the unit and decimals of its first series (`axes.ts`).
  const { axes, axisOf } = planAxes(series, styles, config.defaults);
  const skipped = skippedPoints(chartData(series, styles).stacked.ys, axes, axisOf);
  return (
    <TimeSeriesChart
      series={series}
      styles={styles}
      timeRange={timeRange}
      title={title}
      legend={options.legend}
      tooltip={options.tooltip}
      format={(index, value) =>
        displayText(displayValue(value, "number", series[index]?.options ?? {}, language))
      }
      axes={axes}
      axisOf={axisOf}
      axisFormat={tickFormatter(axes, language)}
      note={
        skipped === 0
          ? undefined
          : t(skipped === 1 ? "panels.axis.skipped.one" : "panels.axis.skipped.other", {
              count: skipped,
            })
      }
    />
  );
}

/**
 * Value axis ticks as text in the unit and decimals of their axis, formatted once per axis and
 * set of ticks (the chart asks tick by tick).
 */
function tickFormatter(
  axes: readonly AxisPlan[],
  language: string,
): (value: number, key: AxisKey, ticks: readonly number[]) => string {
  const last = new Map<AxisKey, { ticks: string; format: (value: number) => string }>();
  return (value, key, ticks) => {
    const joined = ticks.join(",");
    let cached = last.get(key);
    if (cached === undefined || cached.ticks !== joined) {
      const axis = axes.find((a) => a.key === key);
      cached = {
        ticks: joined,
        format: axisTickFormat(ticks, axis?.unit, axis?.decimals, language),
      };
      last.set(key, cached);
    }
    return cached.format(value);
  };
}

function TimeSeriesEditor({ options, onChange }: PanelEditorProps<TimeSeriesOptions>) {
  const { t } = useI18n();
  return (
    <>
      <TextField
        label={t("dashboards.panels.legendTemplate")}
        hint={t("dashboards.panels.legendTemplateHint")}
        value={options.seriesName}
        maxLength={200}
        mono
        onChange={(seriesName) => onChange({ ...options, seriesName })}
      />
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        tooltipDetails
        onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
      />
    </>
  );
}

export const timeseriesPanel: PanelPlugin<TimeSeriesOptions> = {
  type: "timeseries",
  name: "dashboards.panels.timeseries",
  description: "panels.describe.timeseries",
  shapes: ["frame"],
  options: parseOptions,
  Panel: TimeSeriesPanel,
  Editor: TimeSeriesEditor,
  fieldOptions: [
    "colors",
    "axes",
    "graphStyle",
    "standard",
    "range",
    "thresholds",
    "mappings",
    "overrides",
  ],
  Preview: TimeSeriesPreview,
};
