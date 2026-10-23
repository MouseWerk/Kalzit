import { lazy, type ReactNode, Suspense, useId } from "react";
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
import { legacyUnit } from "../fieldConfig/upgrade";
import { TimeSeriesPreview } from "../picker/previews";
import { EmptyPanel, emptyReason, SelectField, TextField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import type { TimeSeriesChartProps } from "./ChartShell";
import { SvgTimeSeriesChart } from "./SvgTimeSeriesChart";
import { buildSeries } from "./series";

export interface TimeSeriesOptions {
  /** Series names from labels, such as "{{job}} on {{instance}}"; empty uses the field names. */
  seriesName: string;
  lineWidth: number;
  legend: LegendOptions;
  tooltip: TooltipOptions;
  /** A unit typed before the field options existed; the field options' unit wins. */
  unit?: string;
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

const LINE_WIDTHS = [1, 2, 3] as const;

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
    lineWidth: LINE_WIDTHS.find((w) => w === value.lineWidth) ?? 1,
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
  if (typeof value.unit === "string" && value.unit !== "") {
    options.unit = value.unit;
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
  const config = legacyUnit(fieldConfig, options.unit);
  const series = buildSeries(frames, options.seriesName, config);
  if (series.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noTimeSeries")} />;
  }
  // The value axis follows the first series' unit and decimals; ends from the defaults.
  const axisOptions = series[0]?.options ?? config.defaults;
  const axisUnit = axisOptions.unit === "none" ? undefined : axisOptions.unit;
  return (
    <TimeSeriesChart
      series={series}
      timeRange={timeRange}
      title={title}
      lineWidth={options.lineWidth}
      legend={options.legend}
      tooltip={options.tooltip.mode}
      format={(index, value) =>
        displayText(displayValue(value, "number", series[index]?.options ?? {}, language))
      }
      axisFormat={(value) =>
        joinFormatted(formatUnit(value, axisUnit, axisOptions.decimals, language))
      }
      yRange={{ min: config.defaults.min, max: config.defaults.max }}
    />
  );
}

function TimeSeriesEditor({ options, onChange }: PanelEditorProps<TimeSeriesOptions>) {
  const { t } = useI18n();
  const id = useId();
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
      <SelectField
        id={`${id}-width`}
        label={t("dashboards.panels.lineWidth")}
        value={String(options.lineWidth) as "1" | "2" | "3"}
        choices={LINE_WIDTHS.map((w) => [String(w) as "1" | "2" | "3", String(w)])}
        onChange={(width) => onChange({ ...options, lineWidth: Number(width) })}
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
  fieldOptions: ["standard", "range", "mappings", "color", "overrides"],
  Preview: TimeSeriesPreview,
};
