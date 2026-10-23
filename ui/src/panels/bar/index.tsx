import { useRef } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import {
  displayNameOf,
  displayText,
  displayValue,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
  type FieldOptions,
  fieldOptionsFor,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { Legend, WithLegend } from "../fieldConfig/Legend";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  seriesStats,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { formatUnit, joinFormatted } from "../fieldConfig/units";
import { legacyUnit } from "../fieldConfig/upgrade";
import { formatValue, rowCount, toNumber, valueFields } from "../frame";
import { BarPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { CheckboxField, EmptyPanel, emptyReason } from "../shared";
import { niceTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

export interface BarOptions {
  showValues: boolean;
  legend: LegendOptions;
  tooltip: TooltipOptions;
  /** A unit typed before the field options existed; the field options' unit wins. */
  unit?: string;
}

function parseOptions(stored: unknown): BarOptions {
  const value = isRecord(stored) ? stored : {};
  const options: BarOptions = {
    showValues: value.showValues === true,
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
  if (typeof value.unit === "string" && value.unit !== "") {
    options.unit = value.unit;
  }
  return options;
}

/** More bars than this would be thinner than a pixel or two; the rest is left out with a note. */
const MAX_BARS = 500;
const AXIS_LEFT = 56;
const AXIS_BOTTOM = 24;
const PAD = 8;

interface BarSeries {
  name: string;
  field: Field;
  options: FieldOptions;
  values: (number | null)[];
}

interface BarData {
  categories: string[];
  series: BarSeries[];
}

/**
 * Categories come from the first text field (or the time field, or the row number); every value
 * field of the first frame with values becomes one bar per category.
 */
export function barData(
  frames: readonly Frame[],
  language: string,
  config: FieldConfig = EMPTY_FIELD_CONFIG,
  timeZone: string | null = null,
): BarData | null {
  const frame = frames.find((f) => valueFields(f).length > 0);
  if (frame === undefined) {
    return null;
  }
  const label: Field | undefined =
    frame.fields.find((f) => f.type === "string") ?? frame.fields.find((f) => f.type === "time");
  const count = Math.min(rowCount(frame), MAX_BARS);
  const categories = Array.from({ length: count }, (_, row) =>
    label === undefined
      ? String(row + 1)
      : formatValue(label.type, label.values[row], language, timeZone),
  );
  const series = valueFields(frame).map((field) => {
    const options = fieldOptionsFor(field, config);
    return {
      name: displayNameOf(field, options),
      field,
      options,
      values: field.values.slice(0, count).map(toNumber),
    };
  });
  return { categories, series };
}

function BarPanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<BarOptions>) {
  const { t, language, timeZone } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const config = legacyUnit(fieldConfig, options.unit);
  const data = barData(frames, language, config, timeZone);
  if (data === null) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  const values = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  let low = 0;
  let high = 0;
  for (const v of values) {
    if (v < low) low = v;
    if (v > high) high = v;
  }
  const ticks = niceTicks(config.defaults.min ?? low, config.defaults.max ?? high, 4);
  const yMin = config.defaults.min ?? ticks[0] ?? 0;
  const yMax = config.defaults.max ?? ticks.at(-1) ?? 1;
  const plotWidth = Math.max(width - AXIS_LEFT - PAD, 10);
  // Values above the bars need room under the top edge.
  const top = options.showValues ? PAD + 14 : PAD;
  const plotHeight = Math.max(height - AXIS_BOTTOM - top, 10);
  const clampY = (v: number) => Math.min(Math.max(v, yMin), yMax);
  const y = (v: number) =>
    top + plotHeight - ((clampY(v) - yMin) / (yMax - yMin || 1)) * plotHeight;
  const group = plotWidth / data.categories.length;
  const barWidth = Math.max((group * 0.8) / data.series.length, 1);
  const labelEvery = Math.ceil(data.categories.length / Math.max(plotWidth / 80, 1));
  const axisOptions = data.series[0]?.options ?? config.defaults;
  const axisUnit = axisOptions.unit === "none" ? undefined : axisOptions.unit;
  const truncated = frames.some((f) => rowCount(f) > MAX_BARS);
  const shown = (s: BarSeries, value: number) =>
    displayValue(value, "number", s.options, language, {
      min: yMin,
      max: yMax,
    });

  const items: ReadoutItem[] = data.categories.map((category, row) => ({
    label: category,
    rows: data.series.map((s, index) => {
      const value = s.values[row];
      const display = value === null || value === undefined ? null : shown(s, value);
      return {
        name: s.name,
        value: display === null ? t("dashboards.panels.noValue") : displayText(display),
        colorClass: toneClass(display?.tone ?? s.options.color, index),
      };
    }),
  }));

  const legendItems = data.series.map((s, index) => {
    const stats = seriesStats(s.values.map((v) => v ?? Number.NaN));
    const values: Record<string, string> = {};
    for (const key of options.legend.values) {
      const value = stats[key];
      values[key] = Number.isNaN(value) ? "" : displayText(shown(s, value));
    }
    return { name: s.name, colorClass: toneClass(s.options.color, index), values };
  });
  // One series needs no legend: the title names it.
  const legend =
    data.series.length > 1 ? <Legend items={legendItems} options={options.legend} /> : null;

  return (
    <div className="bar">
      <WithLegend placement={options.legend.placement} legend={legend}>
        <Readout title={title} items={items} tooltip={options.tooltip.mode} className="bar__plot">
          {(active, hover) => (
            <div className="bar__box" ref={boxRef}>
              <svg className="bar__svg" width={width} height={height} aria-hidden="true">
                {active === null ? null : (
                  <rect
                    className="viz-band"
                    x={AXIS_LEFT + active * group}
                    y={top}
                    width={group}
                    height={plotHeight}
                  />
                )}
                {ticks
                  .filter((tick) => tick >= yMin && tick <= yMax)
                  .map((tick) => (
                    <g key={tick}>
                      <line
                        className="ts__grid"
                        x1={AXIS_LEFT}
                        x2={AXIS_LEFT + plotWidth}
                        y1={y(tick)}
                        y2={y(tick)}
                      />
                      <text className="ts__label" x={AXIS_LEFT - 6} y={y(tick)} textAnchor="end">
                        {joinFormatted(formatUnit(tick, axisUnit, axisOptions.decimals, language))}
                      </text>
                    </g>
                  ))}
                {data.categories.map((category, row) => {
                  const x0 = AXIS_LEFT + row * group + group * 0.1;
                  const single = data.series.length === 1 ? data.series[0] : undefined;
                  const singleValue = single?.values[row];
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: categories can repeat; rows cannot
                    <g key={row} onPointerEnter={() => hover(row)}>
                      {data.series.map((s, index) => {
                        const value = s.values[row];
                        if (value === null || value === undefined) {
                          return null;
                        }
                        const top = y(Math.max(value, 0));
                        const bottom = y(Math.min(value, 0));
                        const tone = shown(s, value).tone ?? s.options.color;
                        return (
                          <rect
                            // biome-ignore lint/suspicious/noArrayIndexKey: series order is fixed
                            key={index}
                            className={`bar__rect ${toneClass(tone, index)}`}
                            x={x0 + index * barWidth}
                            y={top}
                            width={Math.max(barWidth - 1, 1)}
                            height={Math.max(bottom - top, 1)}
                            onPointerEnter={() => hover(row, index)}
                          />
                        );
                      })}
                      {options.showValues && single !== undefined && singleValue != null ? (
                        <text
                          className="ts__label"
                          x={x0 + barWidth / 2}
                          y={y(Math.max(singleValue, 0)) - 6}
                          textAnchor="middle"
                        >
                          {displayText(shown(single, singleValue))}
                        </text>
                      ) : null}
                      {row % labelEvery === 0 ? (
                        <text
                          className="ts__label"
                          x={x0 + (group * 0.8) / 2}
                          y={height - 6}
                          textAnchor="middle"
                        >
                          {category}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </Readout>
      </WithLegend>
      {truncated ? (
        <p className="panel-note">{t("dashboards.panels.barsTruncated", { count: MAX_BARS })}</p>
      ) : null}
    </div>
  );
}

function BarEditor({ options, onChange }: PanelEditorProps<BarOptions>) {
  const { t } = useI18n();
  return (
    <>
      <CheckboxField
        label={t("dashboards.panels.showValues")}
        checked={options.showValues}
        onChange={(showValues) => onChange({ ...options, showValues })}
      />
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
      />
    </>
  );
}

export const barPanel: PanelPlugin<BarOptions> = {
  type: "bar",
  name: "dashboards.panels.bar",
  description: "panels.describe.bar",
  shapes: ["frame"],
  options: parseOptions,
  Panel: BarPanel,
  Editor: BarEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: BarPreview,
};
