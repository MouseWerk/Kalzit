import { useId, useRef } from "react";
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
  type Tone,
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
import { axisTickFormat } from "../fieldConfig/units";
import { legacyUnit } from "../fieldConfig/upgrade";
import { formatValue, rowCount, toNumber, valueFields } from "../frame";
import { labelWidth, useProbeFont } from "../measure";
import { BarPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { CheckboxField, EmptyPanel, emptyReason, SelectField } from "../shared";
import { niceTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

/** Category names under the bars: as many as fit without touching, or none. */
export const CATEGORY_LABELS = ["auto", "hidden"] as const;

export interface BarOptions {
  /** Each bar's value above it, where the bar is wide enough for the text. */
  showValues: boolean;
  categoryLabels: (typeof CATEGORY_LABELS)[number];
  legend: LegendOptions;
  tooltip: TooltipOptions;
  /** A unit typed before the field options existed; the field options' unit wins. */
  unit?: string;
}

function parseOptions(stored: unknown): BarOptions {
  const value = isRecord(stored) ? stored : {};
  const options: BarOptions = {
    showValues: value.showValues === true,
    categoryLabels: CATEGORY_LABELS.find((c) => c === value.categoryLabels) ?? "auto",
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
/** Room between the value axis' labels and the plot. */
const AXIS_GAP = 8;
/** Room below the plot for the category names. */
const AXIS_BOTTOM = 24;
const PAD = 8;
/** Room above a bar for its value. */
const VALUE_ROOM = 14;
/** The room kept between two category labels, in px. */
const LABEL_GAP = 12;
/** Share of a category's width its bars take; the rest separates the categories. */
const GROUP_FILL = 0.8;
/** The gap between bars of one category, in px, where the bars are wide enough for it. */
const BAR_GAP = 2;

/**
 * Where the bars of one category go: the group takes most of the category's width, centered,
 * and its bars share it, with a small gap between them once they are wide enough.
 */
export function barSlots(
  group: number,
  series: number,
): { offset: number; width: number; step: number } {
  const span = group * GROUP_FILL;
  const step = span / Math.max(series, 1);
  const gap = series > 1 && step >= BAR_GAP * 4 ? BAR_GAP : 0;
  return { offset: (group - span) / 2, width: Math.max(step - gap, 1), step };
}

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
 * field of the first frame with values becomes one bar per category, side by side.
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
  const probeRef = useRef<HTMLSpanElement>(null);
  const labelFont = useProbeFont(probeRef);
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
  const axisOptions = data.series[0]?.options ?? config.defaults;
  const axisUnit = axisOptions.unit === "none" ? undefined : axisOptions.unit;
  const inRange = ticks.filter((tick) => tick >= yMin && tick <= yMax);
  const tickText = axisTickFormat(inRange, axisUnit, axisOptions.decimals, language);
  const axisTicks = inRange.map((tick) => ({ tick, text: tickText(tick) }));
  // The value axis is as wide as its widest label, so short labels leave the bars more room.
  const axisLeft =
    Math.ceil(Math.max(0, ...axisTicks.map(({ text }) => labelWidth(text, labelFont)))) + AXIS_GAP;
  const bottom = options.categoryLabels === "hidden" ? PAD : AXIS_BOTTOM;
  const plotWidth = Math.max(width - axisLeft - PAD, 10);
  // Values above the bars need room under the top edge.
  const top = options.showValues ? PAD + VALUE_ROOM : PAD;
  const plotHeight = Math.max(height - bottom - top, 10);
  const clampY = (v: number) => Math.min(Math.max(v, yMin), yMax);
  const y = (v: number) =>
    top + plotHeight - ((clampY(v) - yMin) / (yMax - yMin || 1)) * plotHeight;
  const group = plotWidth / data.categories.length;
  const slots = barSlots(group, data.series.length);
  // Every category gets its label when the longest one fits its width; otherwise every second,
  // third, ... so neighbours never touch.
  const longest = Math.max(...data.categories.map((category) => labelWidth(category, labelFont)));
  const labelEvery = Math.max(Math.ceil((longest + LABEL_GAP) / group), 1);
  const truncated = frames.some((f) => rowCount(f) > MAX_BARS);
  // One series without a color of its own is drawn in the monochrome look (feel.md section 8);
  // several keep the palette.
  const colorOf = (tone: Tone | undefined, index: number) =>
    tone === undefined && data.series.length === 1 ? "series-mono" : toneClass(tone, index);
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
        colorClass: colorOf(display?.tone ?? s.options.color, index),
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
    return { name: s.name, colorClass: colorOf(s.options.color, index), values };
  });
  // One series needs no legend: the title names it.
  const legend =
    data.series.length > 1 ? <Legend items={legendItems} options={options.legend} /> : null;

  return (
    <div className="bar">
      <span className="ts__label visually-hidden" ref={probeRef} aria-hidden="true" />
      <WithLegend placement={options.legend.placement} legend={legend}>
        <Readout title={title} items={items} tooltip={options.tooltip.mode} className="bar__plot">
          {(active, hover) => (
            <div className="bar__box" ref={boxRef}>
              <svg className="bar__svg" width={width} height={height} aria-hidden="true">
                {active === null ? null : (
                  <rect
                    className="viz-band"
                    x={axisLeft + active * group}
                    y={top}
                    width={group}
                    height={plotHeight}
                  />
                )}
                {axisTicks.map(({ tick, text }) => (
                  <g key={tick}>
                    <line
                      className="ts__grid"
                      x1={axisLeft}
                      x2={axisLeft + plotWidth}
                      y1={y(tick)}
                      y2={y(tick)}
                    />
                    <text
                      className="ts__label"
                      x={axisLeft - AXIS_GAP}
                      y={y(tick)}
                      textAnchor="end"
                    >
                      {text}
                    </text>
                  </g>
                ))}
                {data.categories.map((category, row) => {
                  const x0 = axisLeft + row * group + slots.offset;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: categories can repeat; rows cannot
                    <g key={row} onPointerEnter={() => hover(row)}>
                      {data.series.map((s, index) => {
                        const value = s.values[row];
                        if (value === null || value === undefined) {
                          return null;
                        }
                        const barTop = y(Math.max(value, 0));
                        const barBottom = y(Math.min(value, 0));
                        const display = shown(s, value);
                        const tone = display.tone ?? s.options.color;
                        const x = x0 + index * slots.step;
                        const text = options.showValues ? displayText(display) : "";
                        // A value is written at its bar's end (above, or below a negative bar) only
                        // where it fits the bar's width.
                        const fits = text !== "" && labelWidth(text, labelFont) <= slots.step;
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: series order is fixed
                          <g key={index}>
                            <rect
                              className={`bar__rect ${colorOf(tone, index)}`}
                              x={x}
                              y={barTop}
                              width={slots.width}
                              height={Math.max(barBottom - barTop, 1)}
                              onPointerEnter={() => hover(row, index)}
                            />
                            {fits ? (
                              <text
                                className="ts__label"
                                x={x + slots.width / 2}
                                y={value < 0 ? barBottom + VALUE_ROOM / 2 + 4 : barTop - 6}
                                textAnchor="middle"
                              >
                                {text}
                              </text>
                            ) : null}
                          </g>
                        );
                      })}
                      {options.categoryLabels !== "hidden" && row % labelEvery === 0 ? (
                        <text
                          className="ts__label"
                          x={axisLeft + row * group + group / 2}
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
  const id = useId();
  return (
    <>
      <CheckboxField
        label={t("dashboards.panels.showValues")}
        checked={options.showValues}
        onChange={(showValues) => onChange({ ...options, showValues })}
      />
      <SelectField
        id={`${id}-categories`}
        label={t("panels.bar.categoryLabels")}
        value={options.categoryLabels}
        choices={CATEGORY_LABELS.map((c) => [c, t(`panels.bar.categoryLabels.${c}`)])}
        onChange={(categoryLabels) => onChange({ ...options, categoryLabels })}
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
