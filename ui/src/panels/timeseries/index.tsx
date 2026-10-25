import { lazy, type ReactNode, Suspense } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { displayText, displayValue, EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { formatUnit, joinFormatted } from "../fieldConfig/units";
import { legacyLineWidth, legacyUnit } from "../fieldConfig/upgrade";
import { TimeSeriesPreview } from "../picker/previews";
import { EmptyPanel, emptyReason, TextField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import type { TimeSeriesChartProps } from "./ChartShell";
import { SvgTimeSeriesChart } from "./SvgTimeSeriesChart";
import { buildSeries } from "./series";
import { resolveStyles } from "./styles";

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
  const { language } = useI18n();
  const config = legacyLineWidth(legacyUnit(fieldConfig, options.unit), options.lineWidth);
  const series = buildSeries(frames, options.seriesName, config);
  const styles = resolveStyles(series);
  // No rows in the range is one muted line, not an empty chart with axes and a legend.
  const reason = emptyReason(frames, "noTimeSeries");
  if (series.length === 0 || reason === "noData") {
    return <EmptyPanel reason={reason} />;
  }
  // The value axis follows the first series' unit and decimals; ends from the defaults. Series
  // stacked to 100 % put percent on it, from 0 (or -100 with negative values) to 100 unless the
  // ends are set.
  const percent = styles.some((style) => style.stack === "percent");
  const negative =
    percent &&
    series.some((s, i) => styles[i]?.stack === "percent" && s.values.some((value) => value < 0));
  const axisOptions = series[0]?.options ?? config.defaults;
  const axisUnit = percent ? "percent" : axisOptions.unit === "none" ? undefined : axisOptions.unit;
  const axisDecimals = percent ? undefined : axisOptions.decimals;
  return (
    <TimeSeriesChart
      series={series}
      styles={styles}
      timeRange={timeRange}
      title={title}
      legend={options.legend}
      tooltip={options.tooltip.mode}
      format={(index, value) =>
        displayText(displayValue(value, "number", series[index]?.options ?? {}, language))
      }
      axisFormat={(value) => joinFormatted(formatUnit(value, axisUnit, axisDecimals, language))}
      yRange={{
        min: config.defaults.min ?? (percent ? (negative ? -100 : 0) : undefined),
        max: config.defaults.max ?? (percent ? 100 : undefined),
      }}
    />
  );
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
    "graphStyle",
    "standard",
    "range",
    "thresholds",
    "mappings",
    "overrides",
  ],
  Preview: TimeSeriesPreview,
};
