import { useId } from "react";
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
import { PiePreview } from "../picker/previews";
import { Readout } from "../readout";
import { reduceFrames } from "../reduce";
import { EmptyPanel, emptyReason, SelectField } from "../shared";
import { parseReducer, REDUCERS, type Reducer } from "../stat/reduce";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../viz.css";

export const PIE_TYPES = ["pie", "donut"] as const;
export const PIE_LABELS = ["none", "percent", "name", "value"] as const;

export interface PieOptions {
  pieType: (typeof PIE_TYPES)[number];
  reducer: Reducer;
  /** Text outside each slice. */
  labels: (typeof PIE_LABELS)[number];
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

function parseOptions(stored: unknown): PieOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    pieType: PIE_TYPES.find((p) => p === value.pieType) ?? "pie",
    reducer: parseReducer(value.reducer),
    labels: PIE_LABELS.find((l) => l === value.labels) ?? "percent",
    legend: parseLegend(value),
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
        tone: item.display.tone ?? item.options.color,
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

/** A slice as an SVG path between two angles (radians from twelve o'clock, clockwise). */
export function slicePath(from: number, to: number, inner: number, outer = RADIUS): string {
  const at = (r: number, a: number) =>
    `${(CX + r * Math.sin(a)).toFixed(2)} ${(CY - r * Math.cos(a)).toFixed(2)}`;
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
    return `M${CX} ${CY}L${at(outer, from)}A${outer} ${outer} 0 ${large} 1 ${at(outer, to)}Z`;
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
  const inner = options.pieType === "donut" ? HOLE : 0;

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
      columns={[
        { key: "value", label: t("panels.pie.value") },
        { key: "percent", label: t("panels.pie.percent") },
      ]}
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
          <svg className="pie__svg" viewBox="-40 -16 320 272" aria-hidden="true">
            {slices.map((slice, index) => {
              const arc = arcs[index] as { from: number; to: number };
              // The active slice moves out a little along its middle, a quiet highlight.
              const mid = (arc.from + arc.to) / 2;
              const shift = active === index ? 6 : 0;
              return (
                <path
                  // biome-ignore lint/suspicious/noArrayIndexKey: slices keep their order
                  key={index}
                  className={`pie__slice ${classOf(slice, index)}`}
                  d={slicePath(arc.from, arc.to, inner)}
                  transform={
                    shift === 0
                      ? undefined
                      : `translate(${(shift * Math.sin(mid)).toFixed(2)} ${(-shift * Math.cos(mid)).toFixed(2)})`
                  }
                  onPointerEnter={() => hover(index)}
                />
              );
            })}
            {options.labels === "none"
              ? null
              : slices.map((slice, index) => {
                  const arc = arcs[index] as { from: number; to: number };
                  if (arc.to - arc.from < 0.25) return null;
                  const mid = (arc.from + arc.to) / 2;
                  const r = RADIUS + 14;
                  const x = CX + r * Math.sin(mid);
                  const y = CY - r * Math.cos(mid);
                  const text =
                    options.labels === "percent"
                      ? percent.format(slice.value / total)
                      : options.labels === "name"
                        ? nameOf(slice)
                        : valueText(slice);
                  return (
                    <text
                      // biome-ignore lint/suspicious/noArrayIndexKey: slices keep their order
                      key={index}
                      className="pie__label"
                      x={x}
                      y={y}
                      textAnchor={Math.abs(x - CX) < 8 ? "middle" : x > CX ? "start" : "end"}
                    >
                      {text}
                    </text>
                  );
                })}
          </svg>
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
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        withValues={false}
        onChange={(legend, tooltip) => onChange({ ...options, legend, tooltip })}
      />
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
