import { useId, useRef } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import {
  displayNameOf,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
  type FieldOptions,
  fieldOptionsFor,
} from "../fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import { parseTooltip, type TooltipOptions } from "../fieldConfig/legendOptions";
import { formatUnit, joinFormatted } from "../fieldConfig/units";
import { timeField, toNumber, valueFields } from "../frame";
import { HeatmapPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { EmptyPanel, emptyReason, NumberField, SelectField } from "../shared";
import { TIME_LABEL_OVERHANG } from "../timeseries/layout";
import { timeTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

export const HEATMAP_MODES = ["calculate", "buckets"] as const;
export const HEATMAP_SCALES = ["linear", "sqrt"] as const;
export const X_BUCKETS = { min: 2, max: 200, default: 40 } as const;
export const Y_BUCKETS = { min: 2, max: 100, default: 10 } as const;
/** Steps of the color ramp (`--heat-1` to `--heat-8`). */
export const HEAT_STEPS = 8;

export interface HeatmapOptions {
  /**
   * calculate: counts how many values fall into each time and value bucket. buckets: the data
   * already holds buckets, one value field per bucket (as Prometheus histograms do).
   */
  mode: (typeof HEATMAP_MODES)[number];
  xBuckets: number;
  yBuckets: number;
  /** sqrt lifts small counts, so a few busy cells do not leave the rest pale. */
  scale: (typeof HEATMAP_SCALES)[number];
  tooltip: TooltipOptions;
}

function bounded(value: unknown, range: { min: number; max: number; default: number }): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(Math.max(value, range.min), range.max)
    : range.default;
}

function parseOptions(stored: unknown): HeatmapOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    mode: HEATMAP_MODES.find((m) => m === value.mode) ?? "calculate",
    xBuckets: bounded(value.xBuckets, X_BUCKETS),
    yBuckets: bounded(value.yBuckets, Y_BUCKETS),
    scale: HEATMAP_SCALES.find((s) => s === value.scale) ?? "linear",
    tooltip: parseTooltip(value),
  };
}

export interface HeatmapData {
  /** Start time of every column, plus the end of the last. */
  xEdges: number[];
  /** Name of every row, bottom first. */
  rows: string[];
  /** Cell values, column by column: `cells[x * rows.length + y]`. */
  cells: Float64Array;
  max: number;
  /** Options for formatting row bounds in calculate mode. */
  options: FieldOptions;
}

function columnOf(time: number, from: number, to: number, columns: number): number {
  return Math.min(columns - 1, Math.floor(((time - from) / (to - from || 1)) * columns));
}

/** A Prometheus bucket bound (`le`): a number, or `+Inf` for the last bucket. */
function upperBound(le: string | undefined): number | null {
  if (le === undefined) return null;
  if (/^\+?inf$/i.test(le.trim())) return Number.POSITIVE_INFINITY;
  return toNumber(le);
}

/** Ascending bounds with `+Inf` last, compared explicitly (Infinity minus Infinity is NaN). */
export function compareBounds(a: number, b: number): number {
  if (a === b) return 0;
  if (a === Number.POSITIVE_INFINITY) return 1;
  if (b === Number.POSITIVE_INFINITY) return -1;
  return a - b;
}

function maxOf(cells: Float64Array): number {
  let max = 0;
  for (const c of cells) if (c > max) max = c;
  return max;
}

interface BucketSeries {
  time: Field;
  field: Field;
  bound: number;
}

/**
 * Prometheus histogram buckets: each `le` series counts everything up to its bound, so the
 * buckets are cumulative. Per series (its labels without `le`) and per time, each bucket's own
 * count is its value minus the one of the next lower bound, never below zero (a counter reset
 * between scrapes). Rows are the bounds, lowest first; series with the same bound add up.
 */
function promBuckets(
  series: readonly BucketSeries[],
  xEdges: number[],
  range: { from: number; to: number },
  config: FieldConfig,
  language: string,
): HeatmapData {
  const columns = xEdges.length - 1;
  const bounds = [...new Set(series.map((s) => s.bound))].sort(compareBounds);
  const row = new Map(bounds.map((bound, i) => [bound, i]));
  const cells = new Float64Array(columns * bounds.length);
  const groups = new Map<string, BucketSeries[]>();
  for (const s of series) {
    const labels = Object.entries(s.field.labels ?? {})
      .filter(([key]) => key !== "le")
      .sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(labels);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const members of groups.values()) {
    members.sort((a, b) => compareBounds(a.bound, b.bound));
    // time -> cumulative value per member, in bound order
    const byTime = new Map<number, (number | null)[]>();
    members.forEach((s, m) => {
      for (let i = 0; i < s.field.values.length; i++) {
        const t = toNumber(s.time.values[i]);
        const v = toNumber(s.field.values[i]);
        if (t === null || v === null || t < range.from || t > range.to) continue;
        const values = byTime.get(t) ?? new Array<number | null>(members.length).fill(null);
        values[m] = v;
        byTime.set(t, values);
      }
    });
    for (const [t, values] of byTime) {
      const column = columnOf(t, range.from, range.to, columns);
      let below = 0;
      values.forEach((value, m) => {
        if (value === null) return;
        const own = Math.max(0, value - below);
        below = value;
        const y = row.get((members[m] as BucketSeries).bound) ?? 0;
        const at = column * bounds.length + y;
        cells[at] = (cells[at] ?? 0) + own;
      });
    }
  }
  const options = config.defaults;
  const unit = options.unit === "none" ? undefined : options.unit;
  const rows = bounds.map((bound) =>
    bound === Number.POSITIVE_INFINITY
      ? "+Inf"
      : `≤ ${joinFormatted(formatUnit(bound, unit, options.decimals, language))}`,
  );
  return { xEdges, rows, cells, max: maxOf(cells), options };
}

/** Buckets the frames for the heatmap; null when there is no time series to bucket. */
export function heatmapData(
  frames: readonly Frame[],
  options: HeatmapOptions,
  range: { from: number; to: number },
  config: FieldConfig,
  language: string,
): HeatmapData | null {
  const series = frames.flatMap((frame) => {
    const time = timeField(frame);
    return time === undefined ? [] : valueFields(frame).map((field) => ({ time, field }));
  });
  if (series.length === 0) {
    return null;
  }
  const columns = options.xBuckets;
  const xEdges = Array.from(
    { length: columns + 1 },
    (_, i) => range.from + ((range.to - range.from) * i) / columns,
  );
  if (options.mode === "buckets") {
    const bounded = series.map((s) => ({ ...s, bound: upperBound(s.field.labels?.le) }));
    if (bounded.every((s) => s.bound !== null)) {
      return promBuckets(bounded as BucketSeries[], xEdges, range, config, language);
    }
    // Plain bucket fields: one row each, as they came.
    const rows = series.map((s) => displayNameOf(s.field, fieldOptionsFor(s.field, config)));
    const cells = new Float64Array(columns * rows.length);
    series.forEach((s, y) => {
      for (let i = 0; i < s.field.values.length; i++) {
        const t = toNumber(s.time.values[i]);
        const v = toNumber(s.field.values[i]);
        if (t === null || v === null || t < range.from || t > range.to) continue;
        const at = columnOf(t, range.from, range.to, columns) * rows.length + y;
        cells[at] = (cells[at] ?? 0) + v;
      }
    });
    return { xEdges, rows, cells, max: maxOf(cells), options: config.defaults };
  }
  const first = series[0];
  const fieldOptions = first === undefined ? config.defaults : fieldOptionsFor(first.field, config);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const { field } of series) {
    for (const raw of field.values) {
      const v = toNumber(raw);
      if (v === null) continue;
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  if (!Number.isFinite(low)) {
    return null;
  }
  low = fieldOptions.min ?? low;
  high = fieldOptions.max ?? high;
  if (!(high > low)) high = low + 1;
  const count = options.yBuckets;
  const step = (high - low) / count;
  const bound = (i: number) =>
    joinFormatted(formatUnit(low + step * i, fieldOptions.unit, fieldOptions.decimals, language));
  const rows = Array.from({ length: count }, (_, y) => `${bound(y)} – ${bound(y + 1)}`);
  const cells = new Float64Array(columns * count);
  for (const { time, field } of series) {
    for (let i = 0; i < field.values.length; i++) {
      const t = toNumber(time.values[i]);
      const v = toNumber(field.values[i]);
      if (t === null || v === null || t < range.from || t > range.to || v < low || v > high) {
        continue;
      }
      const y = Math.min(count - 1, Math.floor((v - low) / step));
      const at = columnOf(t, range.from, range.to, columns) * count + y;
      cells[at] = (cells[at] ?? 0) + 1;
    }
  }
  let max = 0;
  for (const c of cells) if (c > max) max = c;
  return { xEdges, rows, cells, max, options: fieldOptions };
}

/** The ramp step of a cell, 1 to 8; 0 for an empty cell, which is not drawn. */
export function heatLevel(value: number, max: number, scale: HeatmapOptions["scale"]): number {
  if (!(value > 0) || !(max > 0)) {
    return 0;
  }
  const share = scale === "sqrt" ? Math.sqrt(value / max) : value / max;
  return Math.min(HEAT_STEPS, Math.max(1, Math.ceil(share * HEAT_STEPS)));
}

const AXIS_LEFT = 96;
const AXIS_BOTTOM = 22;
const PAD = 6;
const DAY = 86_400_000;

function HeatmapPanel({
  frames,
  options,
  timeRange,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<HeatmapOptions>) {
  const { t, language, timeZone } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const data = heatmapData(frames, options, timeRange, fieldConfig, language);
  if (data === null) {
    return <EmptyPanel reason={emptyReason(frames, "noTimeSeries")} />;
  }
  const columns = data.xEdges.length - 1;
  const rowCount = data.rows.length;
  const plotWidth = Math.max(width - AXIS_LEFT - PAD, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD, 10);
  const cellWidth = plotWidth / columns;
  const cellHeight = plotHeight / rowCount;
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const { ticks, step } = timeTicks(
    timeRange.from,
    timeRange.to,
    Math.max(2, Math.floor(plotWidth / 110)),
    timeZone,
  );
  const timeLabel = new Intl.DateTimeFormat(
    language,
    step >= DAY
      ? { day: "2-digit", month: "2-digit", ...zoneOption(timeZone) }
      : { hour: "2-digit", minute: "2-digit", ...zoneOption(timeZone) },
  );
  const dateTime = new Intl.DateTimeFormat(language, {
    dateStyle: "short",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const labelEvery = Math.ceil(rowCount / Math.max(1, Math.floor(plotHeight / 16)));

  const cells: { x: number; y: number; value: number }[] = [];
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < rowCount; y++) {
      const value = data.cells[x * rowCount + y] as number;
      if (value > 0) cells.push({ x, y, value });
    }
  }
  const countName = t(
    options.mode === "calculate" ? "panels.heatmap.count" : "panels.heatmap.value",
  );
  const items: ReadoutItem[] = cells.map((cell) => ({
    label: `${dateTime.format(data.xEdges[cell.x] as number)} – ${dateTime.format(data.xEdges[cell.x + 1] as number)}`,
    rows: [
      { name: data.rows[cell.y] ?? "", value: "" },
      {
        name: countName,
        value: number.format(cell.value),
        colorClass: `heat-${heatLevel(cell.value, data.max, options.scale)}`,
      },
    ],
  }));

  return (
    <div className="heatmap">
      <Readout title={title} items={items} tooltip={options.tooltip.mode} className="heatmap__plot">
        {(active, hover) => (
          <div className="heatmap__box" ref={boxRef}>
            <svg className="bar__svg" width={width} height={height} aria-hidden="true">
              {data.rows.map((name, y) =>
                y % labelEvery === 0 ? (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed positions
                    key={y}
                    className="ts__label"
                    x={AXIS_LEFT - 6}
                    y={PAD + plotHeight - (y + 0.5) * cellHeight}
                    textAnchor="end"
                  >
                    {name.length > 16 ? `${name.slice(0, 15)}…` : name}
                  </text>
                ) : null,
              )}
              {ticks.map((tick) => {
                const x =
                  AXIS_LEFT +
                  ((tick - timeRange.from) / (timeRange.to - timeRange.from || 1)) * plotWidth;
                // A label centered this close to the right edge would be cut ("09:00 P").
                return x + TIME_LABEL_OVERHANG > width ? null : (
                  <text key={tick} className="ts__label" x={x} y={height - 6} textAnchor="middle">
                    {timeLabel.format(tick)}
                  </text>
                );
              })}
              {cells.map((cell, index) => (
                <rect
                  key={`${cell.x}-${cell.y}`}
                  className={`heatmap__cell heat-${heatLevel(cell.value, data.max, options.scale)}${active === index ? " heatmap__cell--active" : ""}`}
                  x={AXIS_LEFT + cell.x * cellWidth}
                  y={PAD + plotHeight - (cell.y + 1) * cellHeight}
                  width={Math.max(cellWidth - 1, 1)}
                  height={Math.max(cellHeight - 1, 1)}
                  onPointerEnter={() => hover(index)}
                />
              ))}
            </svg>
          </div>
        )}
      </Readout>
      <div className="heatmap__scale">
        <span>{number.format(0)}</span>
        <ul className="heatmap__ramp" aria-hidden="true">
          {Array.from({ length: HEAT_STEPS }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the ramp is fixed
            <li key={i} className={`heatmap__step heat-${i + 1}`} />
          ))}
        </ul>
        <span>{number.format(data.max)}</span>
        <span className="visually-hidden">{countName}</span>
      </div>
    </div>
  );
}

function HeatmapEditor({ options, onChange }: PanelEditorProps<HeatmapOptions>) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <SelectField
        id={`${id}-mode`}
        label={t("panels.heatmap.mode")}
        value={options.mode}
        choices={HEATMAP_MODES.map((m) => [m, t(`panels.heatmap.mode.${m}`)])}
        onChange={(mode) => onChange({ ...options, mode })}
      />
      <NumberField
        label={t("panels.heatmap.xBuckets")}
        value={options.xBuckets}
        min={X_BUCKETS.min}
        max={X_BUCKETS.max}
        step={1}
        onChange={(xBuckets) =>
          xBuckets !== undefined && Number.isInteger(xBuckets)
            ? onChange({ ...options, xBuckets })
            : undefined
        }
      />
      {options.mode === "calculate" ? (
        <NumberField
          label={t("panels.heatmap.yBuckets")}
          value={options.yBuckets}
          min={Y_BUCKETS.min}
          max={Y_BUCKETS.max}
          step={1}
          onChange={(yBuckets) =>
            yBuckets !== undefined && Number.isInteger(yBuckets)
              ? onChange({ ...options, yBuckets })
              : undefined
          }
        />
      ) : null}
      <SelectField
        id={`${id}-scale`}
        label={t("panels.heatmap.scale")}
        value={options.scale}
        choices={HEATMAP_SCALES.map((s) => [s, t(`panels.heatmap.scale.${s}`)])}
        onChange={(scale) => onChange({ ...options, scale })}
      />
      <LegendTooltipEditor
        legend={{ mode: "hidden", placement: "bottom", values: [] }}
        tooltip={options.tooltip}
        withValues={false}
        hideLegend
        onChange={(_legend, tooltip) => onChange({ ...options, tooltip })}
      />
    </>
  );
}

export const heatmapPanel: PanelPlugin<HeatmapOptions> = {
  type: "heatmap",
  name: "panels.type.heatmap",
  description: "panels.describe.heatmap",
  shapes: ["frame"],
  options: parseOptions,
  Panel: HeatmapPanel,
  Editor: HeatmapEditor,
  fieldOptions: ["standard", "range", "overrides"],
  Preview: HeatmapPreview,
};
