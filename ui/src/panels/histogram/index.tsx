import { useRef } from "react";
import { isRecord } from "../../api/client";
import type { Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import {
  displayNameOf,
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
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { formatUnit, joinFormatted } from "../fieldConfig/units";
import { toNumber, valueFields } from "../frame";
import { HistogramPreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { CheckboxField, EmptyPanel, emptyReason, NumberField } from "../shared";
import { niceTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

export const BUCKETS = { min: 2, max: 200 } as const;

export interface HistogramOptions {
  /** Number of buckets; absent picks one from the number of values. */
  bucketCount?: number;
  /** Width of a bucket in the field's unit; wins over the count. */
  bucketSize?: number;
  /** All fields counted together as one distribution. */
  combine: boolean;
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

function parseOptions(stored: unknown): HistogramOptions {
  const value = isRecord(stored) ? stored : {};
  const options: HistogramOptions = {
    combine: value.combine === true,
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
  if (
    typeof value.bucketCount === "number" &&
    Number.isInteger(value.bucketCount) &&
    value.bucketCount >= BUCKETS.min &&
    value.bucketCount <= BUCKETS.max
  ) {
    options.bucketCount = value.bucketCount;
  }
  if (typeof value.bucketSize === "number" && value.bucketSize > 0) {
    options.bucketSize = value.bucketSize;
  }
  return options;
}

export interface Histogram {
  /** Lower bound of every bucket, plus the upper bound of the last. */
  edges: number[];
  series: { name: string; options: FieldOptions; counts: number[] }[];
}

/** Counts the values of every number field (or of all together) into equal buckets. */
export function histogram(
  frames: readonly Frame[],
  options: HistogramOptions,
  config: FieldConfig,
): Histogram | null {
  const fields = frames.flatMap((frame) => valueFields(frame));
  const groups = options.combine
    ? [{ name: "", options: config.defaults, fields }]
    : fields.map((field) => {
        const fieldOptions = fieldOptionsFor(field, config);
        return { name: displayNameOf(field, fieldOptions), options: fieldOptions, fields: [field] };
      });
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const field of fields) {
    for (const raw of field.values) {
      const v = toNumber(raw);
      if (v === null) continue;
      count++;
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  if (count === 0) {
    return null;
  }
  low = config.defaults.min ?? low;
  high = config.defaults.max ?? high;
  if (!(high > low)) high = low + 1;
  let buckets: number;
  let size: number;
  if (options.bucketSize !== undefined) {
    size = options.bucketSize;
    // More than the maximum of buckets: the size grows by whole multiples until they fit, so
    // every value still lands in its own bucket instead of piling up in the last one.
    const needed = Math.ceil((high - Math.floor(low / size) * size) / size + 1e-9);
    if (needed > BUCKETS.max) {
      size *= Math.ceil(needed / BUCKETS.max);
    }
    low = Math.floor(low / size) * size;
    buckets = Math.max(1, Math.ceil((high - low) / size + 1e-9));
  } else {
    buckets = options.bucketCount ?? Math.min(50, Math.max(5, Math.ceil(Math.sqrt(count))));
    size = (high - low) / buckets;
  }
  const edges = Array.from({ length: buckets + 1 }, (_, i) => low + i * size);
  const series = groups.map((group) => {
    const counts = new Array<number>(buckets).fill(0);
    for (const field of group.fields) {
      for (const raw of field.values) {
        const v = toNumber(raw);
        if (v === null || v < low || v > high) continue;
        const index = Math.min(buckets - 1, Math.floor((v - low) / size));
        counts[index] = (counts[index] ?? 0) + 1;
      }
    }
    return { name: group.name, options: group.options, counts };
  });
  return { edges, series };
}

const AXIS_LEFT = 48;
const AXIS_BOTTOM = 22;
const PAD = 8;

function HistogramPanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<HistogramOptions>) {
  const { t, language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const data = histogram(frames, options, fieldConfig);
  if (data === null) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  const buckets = data.edges.length - 1;
  let top = 0;
  for (const s of data.series) for (const c of s.counts) if (c > top) top = c;
  const ticks = niceTicks(0, Math.max(top, 1), 4);
  const yMax = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(width - AXIS_LEFT - PAD, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD, 10);
  const y = (v: number) => PAD + plotHeight - (v / (yMax || 1)) * plotHeight;
  const group = plotWidth / buckets;
  const barWidth = group / data.series.length;
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
  const unitOptions = data.series[0]?.options ?? fieldConfig.defaults;
  const bound = (v: number) =>
    joinFormatted(
      formatUnit(
        v,
        unitOptions.unit === "none" ? undefined : unitOptions.unit,
        unitOptions.decimals,
        language,
      ),
    );
  const labelEvery = Math.ceil((buckets + 1) / Math.max(plotWidth / 70, 1));
  const nameOf = (name: string) => (name === "" ? t("panels.histogram.count") : name);
  const items: ReadoutItem[] = Array.from({ length: buckets }, (_, b) => ({
    label: `${bound(data.edges[b] as number)} – ${bound(data.edges[b + 1] as number)}`,
    rows: data.series.map((s, index) => ({
      name: nameOf(s.name),
      value: number.format(s.counts[b] ?? 0),
      colorClass: toneClass(s.options.color, index),
    })),
  }));
  const legend =
    data.series.length > 1 ? (
      <Legend
        options={options.legend}
        columns={[]}
        items={data.series.map((s, index) => ({
          name: nameOf(s.name),
          colorClass: toneClass(s.options.color, index),
        }))}
      />
    ) : null;

  return (
    <WithLegend placement={options.legend.placement} legend={legend}>
      <Readout title={title} items={items} tooltip={options.tooltip.mode} className="bar__plot">
        {(active, hover) => (
          <div className="bar__box" ref={boxRef}>
            <svg className="bar__svg" width={width} height={height} aria-hidden="true">
              {active === null ? null : (
                <rect
                  className="viz-band"
                  x={AXIS_LEFT + active * group}
                  y={PAD}
                  width={group}
                  height={plotHeight}
                />
              )}
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    className="ts__grid"
                    x1={AXIS_LEFT}
                    x2={AXIS_LEFT + plotWidth}
                    y1={y(tick)}
                    y2={y(tick)}
                  />
                  <text className="ts__label" x={AXIS_LEFT - 6} y={y(tick)} textAnchor="end">
                    {number.format(tick)}
                  </text>
                </g>
              ))}
              {data.edges.map((edge, i) =>
                i % labelEvery === 0 ? (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: edges are fixed positions
                    key={i}
                    className="ts__label"
                    x={AXIS_LEFT + i * group}
                    y={height - 6}
                    textAnchor="middle"
                  >
                    {bound(edge)}
                  </text>
                ) : null,
              )}
              {Array.from({ length: buckets }, (_, b) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: buckets are fixed positions
                <g key={b} onPointerEnter={() => hover(b)}>
                  {data.series.map((s, index) => {
                    const count = s.counts[b] ?? 0;
                    if (count === 0) return null;
                    return (
                      <rect
                        // biome-ignore lint/suspicious/noArrayIndexKey: series order is fixed
                        key={index}
                        className={`bar__rect ${toneClass(s.options.color, index)}`}
                        x={AXIS_LEFT + b * group + index * barWidth}
                        y={y(count)}
                        width={Math.max(barWidth - 1, 1)}
                        height={Math.max(y(0) - y(count), 1)}
                        onPointerEnter={() => hover(b, index)}
                      />
                    );
                  })}
                </g>
              ))}
            </svg>
          </div>
        )}
      </Readout>
    </WithLegend>
  );
}

function HistogramEditor({ options, onChange }: PanelEditorProps<HistogramOptions>) {
  const { t } = useI18n();
  const without = <K extends "bucketCount" | "bucketSize">(key: K) => {
    const next = { ...options };
    delete next[key];
    return next;
  };
  return (
    <>
      <NumberField
        label={t("panels.histogram.bucketCount")}
        hint={t("panels.histogram.bucketCountHint")}
        value={options.bucketCount}
        min={BUCKETS.min}
        max={BUCKETS.max}
        step={1}
        onChange={(bucketCount) =>
          bucketCount === undefined
            ? onChange(without("bucketCount"))
            : Number.isInteger(bucketCount)
              ? onChange({ ...options, bucketCount })
              : undefined
        }
      />
      <NumberField
        label={t("panels.histogram.bucketSize")}
        value={options.bucketSize}
        min={0}
        onChange={(bucketSize) =>
          bucketSize === undefined || bucketSize <= 0
            ? onChange(without("bucketSize"))
            : onChange({ ...options, bucketSize })
        }
      />
      <CheckboxField
        label={t("panels.histogram.combine")}
        checked={options.combine}
        onChange={(combine) => onChange({ ...options, combine })}
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

export const histogramPanel: PanelPlugin<HistogramOptions> = {
  type: "histogram",
  name: "panels.type.histogram",
  description: "panels.describe.histogram",
  shapes: ["frame"],
  options: parseOptions,
  Panel: HistogramPanel,
  Editor: HistogramEditor,
  fieldOptions: ["standard", "range", "color", "overrides"],
  Preview: HistogramPreview,
};
