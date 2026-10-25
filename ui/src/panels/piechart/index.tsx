import { useId, useRef } from "react";
import { isRecord } from "../../api/client";
import type { Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import {
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
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { formatValue, rowCount, toNumber, valueFields } from "../frame";
import { labelWidth, useProbeFont } from "../measure";
import { PiePreview } from "../picker/previews";
import { Readout } from "../readout";
import { reduceFrames } from "../reduce";
import { CheckboxField, EmptyPanel, emptyReason, SelectField } from "../shared";
import { parseReducer, REDUCERS, type Reducer } from "../stat/reduce";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

export const PIE_TYPES = ["pie", "donut"] as const;
export const PIE_LABELS = ["none", "percent", "name", "value"] as const;
/** On the slices (where the text fits) or outside the circle next to them. */
export const LABEL_PLACEMENTS = ["inside", "outside"] as const;
/** The legend's columns: each slice's value and its share of the whole. */
export const PIE_LEGEND_VALUES = ["value", "percent"] as const;
export type PieLegendValue = (typeof PIE_LEGEND_VALUES)[number];

export interface PieOptions {
  pieType: (typeof PIE_TYPES)[number];
  reducer: Reducer;
  /** Text on or beside each slice. */
  labels: (typeof PIE_LABELS)[number];
  labelPlacement: (typeof LABEL_PLACEMENTS)[number];
  legend: LegendOptions;
  /** The legend's values, in this order. */
  legendValues: PieLegendValue[];
  tooltip: TooltipOptions;
}

function parseOptions(stored: unknown): PieOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    pieType: PIE_TYPES.find((p) => p === value.pieType) ?? "pie",
    reducer: parseReducer(value.reducer),
    labels: PIE_LABELS.find((l) => l === value.labels) ?? "percent",
    labelPlacement: LABEL_PLACEMENTS.find((p) => p === value.labelPlacement) ?? "inside",
    legend: parseLegend(value),
    // In the stored order, each once; the server refuses repeats.
    legendValues: Array.isArray(value.legendValues)
      ? [
          ...new Set(
            (value.legendValues as unknown[]).filter((v): v is PieLegendValue =>
              PIE_LEGEND_VALUES.some((known) => known === v),
            ),
          ),
        ]
      : [...PIE_LEGEND_VALUES],
    tooltip: parseTooltip(value),
  };
}

/** Slices beyond this many are summed into one "other" slice, so every slice stays readable. */
export const MAX_SLICES = 20;

export interface Slice {
  name: string;
  /** The slice that sums up the smallest ones; its name comes from the catalog. */
  other?: boolean;
  value: number;
  options: FieldOptions;
  tone: Tone | undefined;
}

/**
 * The slices: with a text field and several rows, one slice per row of the first value field
 * (the text names it); otherwise one slice per value field, reduced. Negative and missing
 * values have no share of a whole and are left out.
 */
export function pieSlices(
  frames: readonly Frame[],
  config: FieldConfig,
  reducer: Reducer,
  language: string,
): Slice[] {
  const byRow = frames.find(
    (f) => f.fields.some((field) => field.type === "string") && valueFields(f).length > 0,
  );
  const slices: Slice[] = [];
  if (byRow !== undefined && rowCount(byRow) > 1) {
    const label = byRow.fields.find((field) => field.type === "string");
    const field = valueFields(byRow)[0];
    if (label !== undefined && field !== undefined) {
      const options = fieldOptionsFor(field, config);
      for (let row = 0; row < rowCount(byRow); row++) {
        const value = toNumber(field.values[row]);
        if (value === null || value <= 0) continue;
        const display = displayValue(field.values[row], field.type, options, language);
        slices.push({
          name: formatValue(label.type, label.values[row], language),
          value,
          options,
          tone: display.tone,
        });
      }
    }
  } else {
    for (const item of reduceFrames(frames, config, reducer, language)) {
      const value = item.display.numeric;
      if (value === null || value <= 0) continue;
      slices.push({
        name: item.name,
        value,
        options: item.options,
        tone: item.display.tone ?? toneOf(item.options.color),
      });
    }
  }
  if (slices.length <= MAX_SLICES) {
    return slices;
  }
  const kept = [...slices].sort((a, b) => b.value - a.value);
  const rest = kept.slice(MAX_SLICES - 1);
  return [
    ...kept.slice(0, MAX_SLICES - 1),
    {
      name: "",
      other: true,
      value: rest.reduce((sum, s) => sum + s.value, 0),
      options: rest[0]?.options ?? {},
      tone: "neutral",
    },
  ];
}

const CX = 120;
const CY = 120;
const RADIUS = 92;
const HOLE = 56;
/** From the circle to its labels, a label's half height, and the active slice's shift, in px. */
const LABEL_OFFSET = 10;
const LABEL_HALF_HEIGHT = 8;
const ACTIVE_SHIFT = 6;
const MIN_RADIUS = 12;
/** Height of a label's line, and the room kept around a label on its slice, in px. */
const LABEL_HEIGHT = 14;
const LABEL_ROOM = 8;
/** A label on a pie sits at this share of the radius, where the slice is wide enough. */
const INSIDE_AT = 0.64;

/**
 * Where a label goes on its slice, or null when it does not fit there: at the middle of the
 * ring for a donut, a little outside the middle for a pie. The label is horizontal text, so its
 * box (with a little room around it) is tested corner by corner: every corner has to lie inside
 * the ring and within the slice's angles, wherever on the circle the slice is.
 */
export function insideLabel(
  arc: { from: number; to: number },
  inner: number,
  outer: number,
  textWidth: number,
): { radius: number } | null {
  const radius = inner > 0 ? (inner + outer) / 2 : outer * INSIDE_AT;
  const mid = (arc.from + arc.to) / 2;
  const x = radius * Math.sin(mid);
  const y = -radius * Math.cos(mid);
  const halfWidth = (textWidth + LABEL_ROOM) / 2;
  const halfHeight = (LABEL_HEIGHT + LABEL_ROOM) / 2;
  const whole = arc.to - arc.from >= Math.PI * 2 - 1e-9;
  const TURN = Math.PI * 2;
  const inside = (px: number, py: number) => {
    const distance = Math.hypot(px, py);
    if (distance > outer || distance < inner) return false;
    if (whole) return true;
    // Angles clockwise from twelve o'clock, as the slices are drawn.
    const angle = (((Math.atan2(px, -py) - arc.from) % TURN) + TURN) % TURN;
    return angle <= arc.to - arc.from;
  };
  const fits = [-1, 1].every((sx) =>
    [-1, 1].every((sy) => inside(x + sx * halfWidth, y + sy * halfHeight)),
  );
  return fits ? { radius } : null;
}

/**
 * The circle in the box's own pixels: as large as the box allows once the widest label fits
 * beside it, so labels stay inside the panel at the text size of every other label.
 */
export function pieGeometry(
  width: number,
  height: number,
  labelWidth: number,
): { cx: number; cy: number; radius: number } {
  const room = labelWidth > 0 ? LABEL_OFFSET + ACTIVE_SHIFT : ACTIVE_SHIFT;
  const radius = Math.max(
    Math.min(
      width / 2 - room - labelWidth,
      height / 2 - room - (labelWidth > 0 ? LABEL_HALF_HEIGHT * 2 : 0),
    ),
    MIN_RADIUS,
  );
  return { cx: width / 2, cy: height / 2, radius };
}

/** A slice as an SVG path between two angles (radians from twelve o'clock, clockwise). */
export function slicePath(
  from: number,
  to: number,
  inner: number,
  outer = RADIUS,
  cx = CX,
  cy = CY,
): string {
  const at = (r: number, a: number) =>
    `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  // A full circle cannot be one arc; it is drawn as two halves.
  if (to - from >= Math.PI * 2 - 1e-9) {
    const mid = from + Math.PI;
    const ring = `M${at(outer, from)}A${outer} ${outer} 0 1 1 ${at(outer, mid)}A${outer} ${outer} 0 1 1 ${at(outer, from)}Z`;
    return inner > 0
      ? `${ring}M${at(inner, from)}A${inner} ${inner} 0 1 0 ${at(inner, mid)}A${inner} ${inner} 0 1 0 ${at(inner, from)}Z`
      : ring;
  }
  const large = to - from > Math.PI ? 1 : 0;
  if (inner <= 0) {
    return `M${cx} ${cy}L${at(outer, from)}A${outer} ${outer} 0 ${large} 1 ${at(outer, to)}Z`;
  }
  return `M${at(outer, from)}A${outer} ${outer} 0 ${large} 1 ${at(outer, to)}L${at(inner, to)}A${inner} ${inner} 0 ${large} 0 ${at(inner, from)}Z`;
}

function PiePanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<PieOptions>) {
  const { t, language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const probeRef = useRef<HTMLSpanElement>(null);
  const labelFont = useProbeFont(probeRef);
  const slices = pieSlices(frames, fieldConfig, options.reducer, language);
  if (slices.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const nameOf = (slice: Slice) => (slice.other === true ? t("panels.pie.other") : slice.name);
  const valueText = (slice: Slice) =>
    displayText(displayValue(slice.value, "number", slice.options, language));
  const classOf = (slice: Slice, index: number) => toneClass(slice.tone, index);
  let angle = 0;
  const arcs = slices.map((slice) => {
    const from = angle;
    angle += (slice.value / total) * Math.PI * 2;
    return { from, to: angle };
  });
  const inside = options.labelPlacement === "inside";
  // Labels for slices wide enough to carry one; outside ones are measured to size the circle
  // around them, inside ones are kept only where they fit their slice.
  const texts = slices.map((slice, index) => {
    const arc = arcs[index] as { from: number; to: number };
    if (options.labels === "none" || (!inside && arc.to - arc.from < 0.25)) return null;
    return options.labels === "percent"
      ? percent.format(slice.value / total)
      : options.labels === "name"
        ? nameOf(slice)
        : valueText(slice);
  });
  const widest = inside
    ? 0
    : Math.max(0, ...texts.map((text) => (text === null ? 0 : labelWidth(text, labelFont))));
  const { cx, cy, radius } = pieGeometry(width, height, widest);
  const inner = options.pieType === "donut" ? (radius * HOLE) / RADIUS : 0;
  const labels = texts.map((text, index) => {
    if (text === null) return null;
    const arc = arcs[index] as { from: number; to: number };
    if (!inside) return { text, radius: radius + LABEL_OFFSET };
    const place = insideLabel(arc, inner, radius, labelWidth(text, labelFont));
    return place === null ? null : { text, radius: place.radius };
  });

  const items = slices.map((slice, index) => ({
    label: "",
    rows: [
      {
        name: nameOf(slice),
        value: `${valueText(slice)} (${percent.format(slice.value / total)})`,
        colorClass: classOf(slice, index),
      },
    ],
  }));
  const legend = (
    <Legend
      options={options.legend}
      columns={options.legendValues.map((key) => ({ key, label: t(`panels.pie.${key}`) }))}
      items={slices.map((slice, index) => ({
        name: nameOf(slice),
        colorClass: classOf(slice, index),
        values: { value: valueText(slice), percent: percent.format(slice.value / total) },
      }))}
    />
  );

  return (
    <WithLegend placement={options.legend.placement} legend={legend}>
      <Readout title={title} items={items} tooltip={options.tooltip.mode} className="pie">
        {(active, hover) => (
          <div className="pie__box" ref={boxRef}>
            <span className="pie__label visually-hidden" ref={probeRef} aria-hidden="true" />
            <svg className="pie__svg" width={width} height={height} aria-hidden="true">
              {slices.map((slice, index) => {
                const arc = arcs[index] as { from: number; to: number };
                // The active slice moves out a little along its middle, a quiet highlight.
                const mid = (arc.from + arc.to) / 2;
                const shift = active === index ? ACTIVE_SHIFT : 0;
                return (
                  <path
                    // biome-ignore lint/suspicious/noArrayIndexKey: slices keep their order
                    key={index}
                    className={`pie__slice ${classOf(slice, index)}`}
                    d={slicePath(arc.from, arc.to, inner, radius, cx, cy)}
                    transform={
                      shift === 0
                        ? undefined
                        : `translate(${(shift * Math.sin(mid)).toFixed(2)} ${(-shift * Math.cos(mid)).toFixed(2)})`
                    }
                    onPointerEnter={() => hover(index)}
                  />
                );
              })}
              {labels.map((label, index) => {
                if (label === null) return null;
                const arc = arcs[index] as { from: number; to: number };
                const mid = (arc.from + arc.to) / 2;
                // An inside label moves out with its slice when that is active.
                const r = label.radius + (inside && active === index ? ACTIVE_SHIFT : 0);
                const x = cx + r * Math.sin(mid);
                const y = cy - r * Math.cos(mid);
                const anchor = inside || Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end";
                return (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: slices keep their order
                    key={index}
                    className={
                      inside
                        ? `pie__label pie__label--inside ${classOf(slices[index] as Slice, index)}`
                        : "pie__label"
                    }
                    x={x.toFixed(2)}
                    y={y.toFixed(2)}
                    textAnchor={anchor}
                  >
                    {label.text}
                  </text>
                );
              })}
            </svg>
          </div>
        )}
      </Readout>
    </WithLegend>
  );
}

function PieEditor({ options, onChange }: PanelEditorProps<PieOptions>) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <SelectField
        id={`${id}-type`}
        label={t("panels.pie.type")}
        value={options.pieType}
        choices={PIE_TYPES.map((p) => [p, t(`panels.pie.type.${p}`)])}
        onChange={(pieType) => onChange({ ...options, pieType })}
      />
      <SelectField
        id={`${id}-reducer`}
        label={t("dashboards.panels.reducer")}
        hint={t("panels.pie.reducerHint")}
        value={options.reducer}
        choices={REDUCERS.map((r) => [r, t(`dashboards.panels.reducer.${r}`)])}
        onChange={(reducer) => onChange({ ...options, reducer })}
      />
      <SelectField
        id={`${id}-labels`}
        label={t("panels.pie.labels")}
        value={options.labels}
        choices={PIE_LABELS.map((l) => [l, t(`panels.pie.labels.${l}`)])}
        onChange={(labels) => onChange({ ...options, labels })}
      />
      {options.labels === "none" ? null : (
        <SelectField
          id={`${id}-placement`}
          label={t("panels.pie.labelPlacement")}
          hint={t("panels.pie.labelPlacementHint")}
          value={options.labelPlacement}
          choices={LABEL_PLACEMENTS.map((p) => [p, t(`panels.pie.labelPlacement.${p}`)])}
          onChange={(labelPlacement) => onChange({ ...options, labelPlacement })}
        />
      )}
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        withValues={false}
        onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
      />
      {options.legend.mode === "hidden" ? null : (
        <fieldset className="viz-editor__group">
          <legend className="field__label">{t("panels.legend.values")}</legend>
          {PIE_LEGEND_VALUES.map((value) => (
            <CheckboxField
              key={value}
              label={t(`panels.pie.${value}`)}
              checked={options.legendValues.includes(value)}
              onChange={(checked) =>
                onChange({
                  ...options,
                  // The order stays as chosen; a checked value joins at the end.
                  legendValues: checked
                    ? [...options.legendValues.filter((v) => v !== value), value]
                    : options.legendValues.filter((v) => v !== value),
                })
              }
            />
          ))}
        </fieldset>
      )}
    </>
  );
}

export const pieChartPanel: PanelPlugin<PieOptions> = {
  type: "piechart",
  name: "panels.type.piechart",
  description: "panels.describe.piechart",
  shapes: ["frame"],
  options: parseOptions,
  Panel: PiePanel,
  Editor: PieEditor,
  fieldOptions: ["standard", "mappings", "color", "overrides"],
  Preview: PiePreview,
};
