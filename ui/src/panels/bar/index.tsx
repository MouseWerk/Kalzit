import { useId, useRef } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { fitAxisLabels, MAX_AXIS_SHARE } from "../axis";
import { categoryLabels, clampLabel, LABEL_LINE, TURNED_OFFSET } from "../categoryAxis";
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
  toneOf,
} from "../fieldConfig/fieldConfig";
import { Legend, WithLegend } from "../fieldConfig/Legend";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  legendTexts,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { legacyUnit } from "../fieldConfig/upgrade";
import { formatValue, rowCount, toNumber, valueFields } from "../frame";
import { labelWidth, shortenText, useProbeFont } from "../measure";
import { BarPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { CheckboxField, EmptyPanel, emptyReason, SelectField } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import { AXIS_GAP, axisRoom, barAxis, ValueAxisMarks } from "../valueAxis";
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
const PAD = 8;
/** Room above a bar (or below a negative one) for its value. */
const VALUE_ROOM = 14;
/** From a bar's end to the middle of its value's line, in px. */
const VALUE_OFFSET = 6;
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
    frame.fields.find((f) => f.type === "string") ??
    frame.fields.find((f) => f.type === "time" || f.type === "date");
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
  // A loop, not a spread: many series of many bars would overflow the call stack.
  let low = 0;
  for (const v of values) if (v < low) low = v;
  // The value axis from the panel's axis options (linear, log, log around zero, soft limits).
  const axis = barAxis(values, config.defaults, 4);
  const yMin = axis.min;
  const yMax = axis.max;
  const axisOptions = data.series[0]?.options ?? config.defaults;
  const axisUnit = axisOptions.unit === "none" ? undefined : axisOptions.unit;
  const measure = (text: string) => labelWidth(text, labelFont);
  // The value axis is as wide as its widest label (or the width set for it), so short labels
  // leave the bars more room, but never wider than a share of the chart: longer labels drop their
  // unit or are shortened.
  const tickTexts = fitAxisLabels(
    axis.ticks,
    axisUnit,
    axisOptions.decimals,
    language,
    Math.max((axis.width ?? Math.floor(width * MAX_AXIS_SHARE)) - AXIS_GAP, 0),
    measure,
    labelFont,
  );
  const axisTicks = axis.ticks.map((tick, index) => ({ tick, text: tickTexts[index] ?? "" }));
  const room = axisRoom(axis, Math.max(0, ...tickTexts.map(measure)));
  const axisLeft = room.left;
  const plotWidth = Math.max(width - axisLeft - room.right, 10);
  const group = plotWidth / data.categories.length;
  const slots = barSlots(group, data.series.length);
  // The category names: straight while they fit, else turned or thinned out evenly, never cut
  // at the panel's edge.
  const names =
    options.categoryLabels === "hidden"
      ? null
      : categoryLabels(
          data.categories.map(measure),
          group,
          axisLeft + group / 2,
          height,
          room.right + group / 2,
        );
  // Values below negative bars need room above the category names (or the bottom edge).
  const valuesBelow = options.showValues && low < 0 ? VALUE_ROOM : 0;
  const bottom = (names === null ? PAD : names.height) + valuesBelow;
  // Values above the bars need room under the top edge.
  const top = options.showValues ? PAD + VALUE_ROOM : PAD;
  const plotHeight = Math.max(height - bottom - top, 10);
  const clampY = (v: number) => Math.min(Math.max(v, yMin), yMax);
  const y = (v: number) => top + plotHeight - axis.fraction(clampY(v)) * plotHeight;
  // A log axis has no zero: bars stand on its lower end.
  const base = axis.spec.scale === "log" ? yMin : 0;
  const nameTop = top + plotHeight + valuesBelow;
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
        colorClass: colorOf(display?.tone ?? toneOf(s.options.color), index),
      };
    }),
  }));

  const legendItems = data.series.map((s, index) => {
    const { texts, numbers } = legendTexts(
      options.legend.mode === "hidden" ? [] : options.legend.values,
      s.values,
      undefined,
      (value) => displayText(shown(s, value)),
      language,
      timeZone,
    );
    return {
      name: s.name,
      colorClass: colorOf(toneOf(s.options.color), index),
      values: texts,
      numbers,
    };
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
                <ValueAxisMarks
                  axis={axis}
                  ticks={axisTicks}
                  y={y}
                  plotLeft={axisLeft}
                  plotWidth={plotWidth}
                  top={top}
                  plotHeight={plotHeight}
                  boxWidth={width}
                />
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
                        if (axis.spec.scale === "log" && value <= 0) {
                          return null;
                        }
                        const barTop = y(Math.max(value, base));
                        const barBottom = y(Math.min(value, base));
                        const display = shown(s, value);
                        const tone = display.tone ?? toneOf(s.options.color);
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
                                y={
                                  value < 0
                                    ? barBottom + VALUE_ROOM - VALUE_OFFSET
                                    : barTop - VALUE_OFFSET
                                }
                                textAnchor="middle"
                              >
                                {text}
                              </text>
                            ) : null}
                          </g>
                        );
                      })}
                      {names === null || row % names.every !== 0 ? null : (
                        <CategoryName
                          text={shortenText(category, names.maxWidth, labelFont)}
                          x={axisLeft + row * group + group / 2}
                          top={nameTop}
                          bottom={height}
                          width={width}
                          turned={names.turned}
                          measure={measure}
                        />
                      )}
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
      {axis.skipped === 0 ? null : (
        <p className="panel-note">
          {t(axis.skipped === 1 ? "panels.axis.skipped.one" : "panels.axis.skipped.other", {
            count: axis.skipped,
          })}
        </p>
      )}
    </div>
  );
}

/** One category's name under the plot: straight and kept inside the chart, or turned. */
function CategoryName({
  text,
  x,
  top,
  bottom,
  width,
  turned,
  measure,
}: {
  text: string;
  x: number;
  top: number;
  bottom: number;
  width: number;
  turned: boolean;
  measure: (text: string) => number;
}) {
  if (turned) {
    // The name ends under its category and runs down to the left.
    const y = top + TURNED_OFFSET + LABEL_LINE / 2;
    return (
      <text
        className="ts__label"
        x={x}
        y={y}
        textAnchor="end"
        transform={`rotate(-45 ${x.toFixed(2)} ${y.toFixed(2)})`}
      >
        {text}
      </text>
    );
  }
  return (
    <text
      className="ts__label"
      x={clampLabel(x, measure(text), width)}
      y={bottom - 6}
      textAnchor="middle"
    >
      {text}
    </text>
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
  fieldOptions: ["axes", "standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: BarPreview,
};
