import { isRecord } from "../../api/client";
import { type Translate, useI18n } from "../../i18n/i18n";
import {
  displayText,
  displayValue,
  EMPTY_FIELD_CONFIG,
  fieldOptionsFor,
} from "../fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { formatUnit, joinFormatted } from "../fieldConfig/units";
import { type FitAction, FitHint } from "../fitHint";
import { isNumeric } from "../frame";
import { TrendPreview } from "../picker/previews";
import { EmptyPanel, emptyReason, SelectField, TextField } from "../shared";
import { SvgTimeSeriesChart } from "../timeseries/SvgTimeSeriesChart";
import { resolveStyles } from "../timeseries/styles";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { buildTrend, fixStep, type TrendIssue } from "./trendData";

/**
 * The Trend panel: a time series whose X axis is an ascending number field instead of time (an
 * account's age, a level, a quantity, a calendar week). How series are drawn, the axes, legend
 * and tooltip are the time series' (docs/design/blueprint/XYMapTrend.dc.html, frames 6 and 7).
 */
export interface TrendOptions {
  /** The X field by name; absent: the first number field whose values ascend. */
  xField?: string;
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

const MAX_FIELD_CHARS = 200;

function parseOptions(stored: unknown): TrendOptions {
  const value = isRecord(stored) ? stored : {};
  const options: TrendOptions = { legend: parseLegend(value), tooltip: parseTooltip(value) };
  if (typeof value.xField === "string" && value.xField !== "") {
    options.xField = value.xField.slice(0, MAX_FIELD_CHARS);
  }
  return options;
}

/** The hint's title, sentence and ways out for an issue (frame 7 of the board). */
export function trendHint(
  t: Translate,
  issue: TrendIssue,
  step: ReturnType<typeof fixStep>,
  number: (n: number) => string,
): { title: string; text: string; actions: FitAction[] } {
  const xy: FitAction = { kind: "type", label: t("panels.trend.showAsXY"), type: "xy" };
  switch (issue.kind) {
    case "falls":
      return {
        title: t("panels.trend.falls"),
        text: t("panels.trend.fallsText", {
          field: issue.field,
          row: number(issue.row + 1),
          rows: number(issue.rows),
          value: number(issue.value),
        }),
        actions: [
          ...(step === null
            ? []
            : [{ kind: "step" as const, label: t("panels.trend.addSort"), step }]),
          xy,
        ],
      };
    case "repeats":
      return {
        title: t("panels.trend.repeats"),
        text: t("panels.trend.repeatsText", {
          field: issue.field,
          value: number(issue.value),
          count: issue.count,
        }),
        actions: [
          ...(step === null
            ? []
            : [{ kind: "step" as const, label: t("panels.trend.addGroup"), step }]),
          xy,
        ],
      };
    case "text":
      return {
        title: t("panels.trend.text"),
        text: t("panels.trend.textText", { field: issue.field, example: issue.example }),
        // The step "Convert type" comes with the next step package; until then the bar chart
        // takes text categories as they are.
        actions: [{ kind: "type", label: t("panels.trend.showAsBar"), type: "bar" }],
      };
    case "missing":
      return {
        title: t("panels.trend.missing"),
        text: t("panels.trend.missingText", { field: issue.field }),
        actions: [],
      };
    case "noSeries":
      return {
        title: t("panels.trend.noSeries"),
        text: t("panels.trend.noSeriesText", { field: issue.field }),
        actions: [],
      };
    case "tooMany":
      return {
        title: t("panels.trend.tooMany"),
        text: t("panels.trend.tooManyText", { rows: number(issue.rows) }),
        actions: [xy],
      };
  }
}

function TrendPanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<TrendOptions>) {
  const { t, language } = useI18n();
  const reason = emptyReason(frames, "noValues");
  if (reason === "noData") {
    return <EmptyPanel reason={reason} />;
  }
  const { data, issue } = buildTrend(frames, options.xField, fieldConfig);
  if (issue !== null) {
    const number = new Intl.NumberFormat(language, { maximumFractionDigits: 6 });
    const hint = trendHint(t, issue.issue, fixStep(issue.frame, issue.issue), (n) =>
      number.format(n),
    );
    return <FitHint title={hint.title} text={hint.text} actions={hint.actions} />;
  }
  if (data === null) {
    return <EmptyPanel reason={reason} />;
  }
  const styles = resolveStyles(data.series);
  const xOptions = fieldOptionsFor(data.x, fieldConfig);
  const yOptions = data.series[0]?.options ?? fieldConfig.defaults;
  const unit = (u: string | undefined) => (u === "none" ? undefined : u);
  return (
    <SvgTimeSeriesChart
      series={data.series}
      styles={styles}
      timeRange={{ from: data.extent.min, to: data.extent.max }}
      title={title}
      legend={options.legend}
      tooltip={options.tooltip.mode}
      format={(index, value) =>
        displayText(displayValue(value, "number", data.series[index]?.options ?? {}, language))
      }
      axisFormat={(value) =>
        joinFormatted(formatUnit(value, unit(yOptions.unit), yOptions.decimals, language))
      }
      yRange={{ min: fieldConfig.defaults.min, max: fieldConfig.defaults.max }}
      numberAxis={{
        format: (x) =>
          joinFormatted(formatUnit(x, unit(xOptions.unit), xOptions.decimals, language)),
      }}
    />
  );
}

function TrendEditor({ options, onChange, fields }: PanelEditorProps<TrendOptions>) {
  const { t } = useI18n();
  const numbers = (fields ?? []).filter((f) => isNumeric(f.type)).map((f) => f.name);
  const setX = (xField: string) => {
    const { xField: _, ...rest } = options;
    onChange(xField === "" ? rest : { ...rest, xField });
  };
  return (
    <>
      {numbers.length === 0 ? (
        <TextField
          label={t("panels.trend.xField")}
          hint={t("panels.trend.xFieldHint")}
          value={options.xField ?? ""}
          maxLength={MAX_FIELD_CHARS}
          mono
          onChange={setX}
        />
      ) : (
        <SelectField
          label={t("panels.trend.xField")}
          hint={t("panels.trend.xFieldHint")}
          value={options.xField ?? ""}
          choices={[
            ["", t("panels.trend.xAuto")],
            ...[
              ...new Set([...numbers, ...(options.xField === undefined ? [] : [options.xField])]),
            ].map((name) => [name, name] as const),
          ]}
          onChange={setX}
        />
      )}
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
      />
    </>
  );
}

export const trendPanel: PanelPlugin<TrendOptions> = {
  type: "trend",
  name: "panels.type.trend",
  description: "panels.describe.trend",
  shapes: ["frame"],
  options: parseOptions,
  Panel: TrendPanel,
  Editor: TrendEditor,
  fieldOptions: [
    "colors",
    "graphStyle",
    "standard",
    "range",
    "thresholds",
    "mappings",
    "overrides",
  ],
  Preview: TrendPreview,
};
