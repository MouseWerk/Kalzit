import { type ReactNode, useId } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { EmptyPanel, UnitField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { buildSeries } from "./series";
import { SvgTimeSeriesChart, type TimeSeriesChartProps } from "./SvgTimeSeriesChart";

export interface TimeSeriesOptions {
  unit: string;
  /** Series names from labels, such as "{{job}} on {{instance}}"; empty uses the field names. */
  legend: string;
  lineWidth: number;
  showLegend: boolean;
}

/**
 * The chart renderer. uPlot is the planned one (canvas, built for many points); until the package
 * is added, the SVG chart with per-pixel decimation renders the same props. Swap it here.
 */
const TimeSeriesChart: (props: TimeSeriesChartProps) => ReactNode = SvgTimeSeriesChart;

const LINE_WIDTHS = [1, 2, 3] as const;

function parseOptions(stored: unknown): TimeSeriesOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    unit: typeof value.unit === "string" ? value.unit : "",
    legend: typeof value.legend === "string" ? value.legend : "",
    lineWidth: LINE_WIDTHS.find((w) => w === value.lineWidth) ?? 1,
    showLegend: value.showLegend !== false,
  };
}

function TimeSeriesPanel({ frames, options, timeRange, title }: PanelProps<TimeSeriesOptions>) {
  const series = buildSeries(frames, options.legend);
  if (series.length === 0) {
    return <EmptyPanel reason="noTimeSeries" />;
  }
  return (
    <TimeSeriesChart
      series={series}
      timeRange={timeRange}
      title={title}
      unit={options.unit}
      lineWidth={options.lineWidth}
      showLegend={options.showLegend}
    />
  );
}

function TimeSeriesEditor({ options, onChange }: PanelEditorProps<TimeSeriesOptions>) {
  const { t } = useI18n();
  const widthId = useId();
  const legendId = useId();
  const templateId = useId();
  return (
    <>
      <UnitField value={options.unit} onChange={(unit) => onChange({ ...options, unit })} />
      <div className="field">
        <label className="field__label" htmlFor={templateId}>
          {t("dashboards.panels.legendTemplate")}
        </label>
        <p className="field__hint" id={`${templateId}-hint`}>
          {t("dashboards.panels.legendTemplateHint")}
        </p>
        <input
          id={templateId}
          className="input input--mono"
          value={options.legend}
          aria-describedby={`${templateId}-hint`}
          onChange={(event) => onChange({ ...options, legend: event.currentTarget.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={widthId}>
          {t("dashboards.panels.lineWidth")}
        </label>
        <select
          id={widthId}
          className="select"
          value={options.lineWidth}
          onChange={(event) =>
            onChange({ ...options, lineWidth: Number(event.currentTarget.value) })
          }
        >
          {LINE_WIDTHS.map((width) => (
            <option key={width} value={width}>
              {width}
            </option>
          ))}
        </select>
      </div>
      <label className="checkbox" htmlFor={legendId}>
        <input
          id={legendId}
          type="checkbox"
          checked={options.showLegend}
          onChange={(event) => onChange({ ...options, showLegend: event.currentTarget.checked })}
        />
        {t("dashboards.panels.showLegend")}
      </label>
    </>
  );
}

export const timeseriesPanel: PanelPlugin<TimeSeriesOptions> = {
  type: "timeseries",
  name: "dashboards.panels.timeseries",
  shapes: ["frame"],
  options: parseOptions,
  Panel: TimeSeriesPanel,
  Editor: TimeSeriesEditor,
};
