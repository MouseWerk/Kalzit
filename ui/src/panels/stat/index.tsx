import { useId } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { formatValue, seriesName, timeField, toNumber, valueFields } from "../frame";
import { EmptyPanel, emptyReason, UnitField } from "../shared";
import { SERIES_COLORS } from "../timeseries/ChartShell";
import { seriesPath, valueExtent } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";

export const REDUCERS = ["last", "mean", "min", "max", "sum"] as const;
export type Reducer = (typeof REDUCERS)[number];

export interface StatOptions {
  reducer: Reducer;
  unit: string;
  sparkline: boolean;
}

function parseOptions(stored: unknown): StatOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    reducer: REDUCERS.find((r) => r === value.reducer) ?? "last",
    unit: typeof value.unit === "string" ? value.unit : "",
    sparkline: value.sparkline !== false,
  };
}

/**
 * Reduces a field to one value. int64 stays exact through BigInt for every reducer but the mean,
 * so a counter like 9007199254740993 is not shown rounded.
 */
export function reduceField(
  field: Field,
  reducer: Reducer,
): { value: unknown; type: Field["type"] } {
  const present = field.values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) {
    return { value: null, type: field.type };
  }
  if (reducer === "last") {
    return { value: present.at(-1), type: field.type };
  }
  if (field.type === "int64" && reducer !== "mean") {
    try {
      const values = present.map((v) => BigInt(String(v)));
      let result = values[0] as bigint;
      for (const v of values.slice(1)) {
        if (reducer === "sum") result += v;
        if (reducer === "min" && v < result) result = v;
        if (reducer === "max" && v > result) result = v;
      }
      return { value: result.toString(), type: "int64" };
    } catch {
      // Not a decimal string after all; fall through to numbers.
    }
  }
  // One pass in a loop: spreading 100,000 values into Math.min would overflow the call stack.
  let count = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const raw of present) {
    const value = toNumber(raw);
    if (value === null) {
      continue;
    }
    count++;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (count === 0) {
    return { value: null, type: "number" };
  }
  const result =
    reducer === "min" ? min : reducer === "max" ? max : reducer === "sum" ? sum : sum / count;
  return { value: result, type: "number" };
}

const SPARK_WIDTH = 200;
const SPARK_HEIGHT = 40;

function Sparkline({ frame, field, index }: { frame: Frame; field: Field; index: number }) {
  const time = timeField(frame);
  if (time === undefined) {
    return null;
  }
  const times = Float64Array.from(time.values, (v) => toNumber(v) ?? Number.NaN);
  const values = Float64Array.from(field.values, (v) => toNumber(v) ?? Number.NaN);
  const series = { name: field.name, times, values };
  const extent = valueExtent([series]);
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? 1;
  if (extent === null || times.length < 2) {
    return null;
  }
  const span = extent.max - extent.min || 1;
  const d = seriesPath(
    series,
    {
      x: (t) => ((t - first) / (last - first || 1)) * SPARK_WIDTH,
      y: (v) => SPARK_HEIGHT - 2 - ((v - extent.min) / span) * (SPARK_HEIGHT - 4),
    },
    SPARK_WIDTH,
  );
  return (
    <svg
      className="stat__sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className={`stat__spark series-${(index % SERIES_COLORS) + 1}`} d={d} />
    </svg>
  );
}

function StatPanel({ frames, options }: PanelProps<StatOptions>) {
  const { language, timeZone } = useI18n();
  const items = frames.flatMap((frame) => valueFields(frame).map((field) => ({ frame, field })));
  if (items.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  return (
    <ul className="stat">
      {items.map(({ frame, field }, index) => {
        const { value, type } = reduceField(field, options.reducer);
        const unit = options.unit !== "" ? options.unit : (field.unit ?? "");
        const text = formatValue(type, value, language, timeZone);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields keep their order in the result
          <li key={index} className="stat__item">
            {items.length > 1 ? (
              <span className="stat__name truncate">{seriesName(field)}</span>
            ) : null}
            <span className="stat__value">
              {text === "" ? "–" : text}
              {unit === "" || text === "" ? null : <span className="stat__unit"> {unit}</span>}
            </span>
            {options.sparkline ? <Sparkline frame={frame} field={field} index={index} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function StatEditor({ options, onChange }: PanelEditorProps<StatOptions>) {
  const { t } = useI18n();
  const reducerId = useId();
  const sparkId = useId();
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={reducerId}>
          {t("dashboards.panels.reducer")}
        </label>
        <select
          id={reducerId}
          className="select"
          value={options.reducer}
          onChange={(event) =>
            onChange({ ...options, reducer: event.currentTarget.value as Reducer })
          }
        >
          {REDUCERS.map((reducer) => (
            <option key={reducer} value={reducer}>
              {t(`dashboards.panels.reducer.${reducer}`)}
            </option>
          ))}
        </select>
      </div>
      <UnitField value={options.unit} onChange={(unit) => onChange({ ...options, unit })} />
      <label className="checkbox" htmlFor={sparkId}>
        <input
          id={sparkId}
          type="checkbox"
          checked={options.sparkline}
          onChange={(event) => onChange({ ...options, sparkline: event.currentTarget.checked })}
        />
        {t("dashboards.panels.sparkline")}
      </label>
    </>
  );
}

export const statPanel: PanelPlugin<StatOptions> = {
  type: "stat",
  name: "dashboards.panels.stat",
  shapes: ["frame"],
  options: parseOptions,
  Panel: StatPanel,
  Editor: StatEditor,
};
