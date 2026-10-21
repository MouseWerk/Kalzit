import { useId, useRef } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { formatValue, rowCount, seriesName, toNumber, valueFields } from "../frame";
import { EmptyPanel, emptyReason, UnitField } from "../shared";
import { SERIES_COLORS } from "../timeseries/ChartShell";
import { niceTicks } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";

export interface BarOptions {
  unit: string;
  showValues: boolean;
}

function parseOptions(stored: unknown): BarOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    unit: typeof value.unit === "string" ? value.unit : "",
    showValues: value.showValues === true,
  };
}

/** More bars than this would be thinner than a pixel or two; the rest is left out with a note. */
const MAX_BARS = 500;
const AXIS_LEFT = 56;
const AXIS_BOTTOM = 24;
const PAD = 8;

interface BarData {
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
}

/**
 * Categories come from the first text field (or the time field, or the row number); every value
 * field of the first frame with values becomes one bar per category.
 */
export function barData(frames: readonly Frame[], language: string): BarData | null {
  const frame = frames.find((f) => valueFields(f).length > 0);
  if (frame === undefined) {
    return null;
  }
  const label: Field | undefined =
    frame.fields.find((f) => f.type === "string") ?? frame.fields.find((f) => f.type === "time");
  const count = Math.min(rowCount(frame), MAX_BARS);
  const categories = Array.from({ length: count }, (_, row) =>
    label === undefined ? String(row + 1) : formatValue(label.type, label.values[row], language),
  );
  const series = valueFields(frame).map((field) => ({
    name: seriesName(field),
    values: field.values.slice(0, count).map(toNumber),
  }));
  return { categories, series };
}

function BarPanel({ frames, options, title }: PanelProps<BarOptions>) {
  const { t, language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const data = barData(frames, language);
  if (data === null) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  const values = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4);
  const yMin = ticks[0] ?? 0;
  const yMax = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(width - AXIS_LEFT - PAD, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD, 10);
  const y = (v: number) => PAD + plotHeight - ((v - yMin) / (yMax - yMin || 1)) * plotHeight;
  const group = plotWidth / data.categories.length;
  const barWidth = Math.max((group * 0.8) / data.series.length, 1);
  const labelEvery = Math.ceil(data.categories.length / Math.max(plotWidth / 80, 1));
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 3 });
  const truncated = frames.some((f) => rowCount(f) > MAX_BARS);

  return (
    <div className="bar">
      <div className="bar__plot" ref={boxRef}>
        <svg className="bar__svg" width={width} height={height} role="img" aria-label={title}>
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
          {data.categories.map((category, row) => {
            const x0 = AXIS_LEFT + row * group + group * 0.1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: categories can repeat; rows cannot
              <g key={row}>
                {data.series.map((s, index) => {
                  const value = s.values[row];
                  if (value === null || value === undefined) {
                    return null;
                  }
                  const top = y(Math.max(value, 0));
                  const bottom = y(Math.min(value, 0));
                  return (
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: series order is fixed
                      key={index}
                      className={`bar__rect series-${(index % SERIES_COLORS) + 1}`}
                      x={x0 + index * barWidth}
                      y={top}
                      width={Math.max(barWidth - 1, 1)}
                      height={Math.max(bottom - top, 1)}
                    >
                      <title>{`${category}: ${number.format(value)}${options.unit === "" ? "" : ` ${options.unit}`}`}</title>
                    </rect>
                  );
                })}
                {options.showValues &&
                data.series.length === 1 &&
                data.series[0]?.values[row] != null ? (
                  <text
                    className="ts__label"
                    x={x0 + barWidth / 2}
                    y={y(Math.max(data.series[0].values[row] ?? 0, 0)) - 4}
                    textAnchor="middle"
                  >
                    {number.format(data.series[0].values[row] ?? 0)}
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
      {truncated ? (
        <p className="panel-note">{t("dashboards.panels.barsTruncated", { count: MAX_BARS })}</p>
      ) : null}
    </div>
  );
}

function BarEditor({ options, onChange }: PanelEditorProps<BarOptions>) {
  const { t } = useI18n();
  const valuesId = useId();
  return (
    <>
      <UnitField value={options.unit} onChange={(unit) => onChange({ ...options, unit })} />
      <label className="checkbox" htmlFor={valuesId}>
        <input
          id={valuesId}
          type="checkbox"
          checked={options.showValues}
          onChange={(event) => onChange({ ...options, showValues: event.currentTarget.checked })}
        />
        {t("dashboards.panels.showValues")}
      </label>
    </>
  );
}

export const barPanel: PanelPlugin<BarOptions> = {
  type: "bar",
  name: "dashboards.panels.bar",
  shapes: ["frame"],
  options: parseOptions,
  Panel: BarPanel,
  Editor: BarEditor,
};
