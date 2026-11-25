import { useId, useRef } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { EMPTY_FIELD_CONFIG, type Tone, toneClass, toneOf } from "../fieldConfig/fieldConfig";
import { legacyUnit } from "../fieldConfig/upgrade";
import { timeField, toNumber } from "../frame";
import { StatPreview } from "../picker/previews";
import { reduceFrames, toneName } from "../reduce";
import { EmptyPanel, emptyReason, SelectField } from "../shared";
import { useStyleVars } from "../styleVars";
import { seriesPath, valueExtent } from "../timeseries/series";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import { parseReducer, REDUCERS, type Reducer } from "./reduce";
import "../viz.css";

export { REDUCERS, type Reducer, reduceField } from "./reduce";

export const COLOR_MODES = ["none", "value", "background"] as const;
export const GRAPH_MODES = ["none", "area"] as const;
export const TEXT_MODES = ["auto", "value", "valueAndName", "name"] as const;

export interface StatOptions {
  reducer: Reducer;
  /** Colors the value or the background by thresholds and mappings. */
  colorMode: (typeof COLOR_MODES)[number];
  /** A trend line with a filled area under the value. */
  graphMode: (typeof GRAPH_MODES)[number];
  /** auto shows names only when there are several values. */
  textMode: (typeof TEXT_MODES)[number];
  /** A unit typed before the field options existed; the field options' unit wins. */
  unit?: string;
}

function parseOptions(stored: unknown): StatOptions {
  const value = isRecord(stored) ? stored : {};
  const options: StatOptions = {
    reducer: parseReducer(value.reducer),
    colorMode: COLOR_MODES.find((m) => m === value.colorMode) ?? "none",
    // Before graphMode, `sparkline: false` turned the trend line off.
    graphMode:
      GRAPH_MODES.find((m) => m === value.graphMode) ??
      (value.sparkline === false ? "none" : "area"),
    textMode: TEXT_MODES.find((m) => m === value.textMode) ?? "auto",
  };
  if (typeof value.unit === "string" && value.unit !== "") {
    options.unit = value.unit;
  }
  return options;
}

const SPARK_WIDTH = 200;
const SPARK_HEIGHT = 40;

function Sparkline({
  frame,
  field,
  colorClass,
}: {
  frame: Frame;
  field: Field;
  colorClass: string;
}) {
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
  // The area closes the line along the bottom; a gap in the data leaves the area open there.
  const area = d.includes("M", 1) ? "" : `${d}L${SPARK_WIDTH} ${SPARK_HEIGHT}L0 ${SPARK_HEIGHT}Z`;
  return (
    <svg
      className={`stat__sparkline ${colorClass}`}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {area === "" ? null : <path className="stat__area" d={area} />}
      <path className="stat__spark" d={d} />
    </svg>
  );
}

/** The gap between values (--space-3, three quarters of a rem). */
const STAT_GAP_REM = 0.75;
/** A value's box needs this height (px) for its trend line under name and value ... */
const SPARKLINE_FROM = 112;
/** ... and this height and width (px) for the large number. */
const LARGE_FROM_HEIGHT = 72;
const LARGE_FROM_WIDTH = 128;

export interface StatLayout {
  columns: number;
  /** The trend lines are left out: the values need the height. */
  compact: boolean;
  /** The values are written smaller. */
  small: boolean;
}

/**
 * How several values share a panel: the number of columns that gives each value the largest box
 * (a value reads best about twice as wide as high), so two values in a short panel stand side
 * by side instead of the second being cut off below the first. Where a box is still short, the
 * trend lines and then the large number give way.
 */
export function statLayout(count: number, width: number, height: number, rem = 16): StatLayout {
  const gap = STAT_GAP_REM * rem;
  let best = { columns: 1, score: -1, cellWidth: width, cellHeight: height };
  for (let columns = 1; columns <= Math.max(count, 1); columns++) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    const score = Math.min(cellWidth, cellHeight * 2);
    if (score > best.score) {
      best = { columns, score, cellWidth, cellHeight };
    }
  }
  return {
    columns: best.columns,
    compact: best.cellHeight < SPARKLINE_FROM,
    small: best.cellHeight < LARGE_FROM_HEIGHT || best.cellWidth < LARGE_FROM_WIDTH,
  };
}

function StatPanel({ frames, options, fieldConfig = EMPTY_FIELD_CONFIG }: PanelProps<StatOptions>) {
  const { t, language, timeZone } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  // The root font size comes with the measured size, never read while rendering (see WithLegend).
  const { width, height, rem } = useElementSize(listRef);
  const config = legacyUnit(fieldConfig, options.unit);
  const items = reduceFrames(frames, config, options.reducer, language, timeZone);
  const layout = statLayout(items.length, width, height, rem);
  useStyleVars(listRef, { "--stat-columns": layout.columns });
  if (items.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  const showName =
    options.textMode === "valueAndName" ||
    options.textMode === "name" ||
    (options.textMode === "auto" && items.length > 1);
  const showValue = options.textMode !== "name";
  return (
    <ul
      ref={listRef}
      className={`stat${layout.compact ? " stat--compact" : ""}${layout.small ? " stat--small" : ""}`}
    >
      {items.map((item) => {
        const tone: Tone | undefined = item.display.tone ?? toneOf(item.options.color);
        const colored = options.colorMode !== "none" && tone !== undefined;
        const classes = [
          "stat__item",
          colored ? toneClass(tone) : "",
          colored && options.colorMode === "background" ? "stat__item--background" : "",
          colored && options.colorMode === "value" ? "stat__item--value" : "",
        ].join(" ");
        const text = item.display.text === "" ? "–" : item.display.text;
        const state = toneName(item.display.tone);
        return (
          <li key={item.index} className={classes}>
            {showName ? (
              <span className="stat__name truncate" title={item.name}>
                {item.name}
              </span>
            ) : null}
            {showValue ? (
              <span className="stat__value">
                {text}
                {item.display.suffix === "" || item.display.text === "" ? null : (
                  <span className="stat__unit">{`\u00a0${item.display.suffix}`}</span>
                )}
                {state === undefined ? null : (
                  <span className="visually-hidden">{` (${t(state)})`}</span>
                )}
              </span>
            ) : null}
            {options.graphMode === "area" ? (
              <Sparkline
                frame={item.frame}
                field={item.field}
                colorClass={toneClass(
                  toneOf(item.options.color) ?? (colored ? tone : undefined),
                  item.index,
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function StatEditor({ options, onChange }: PanelEditorProps<StatOptions>) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <SelectField
        id={`${id}-reducer`}
        label={t("dashboards.panels.reducer")}
        value={options.reducer}
        choices={REDUCERS.map((r) => [r, t(`dashboards.panels.reducer.${r}`)])}
        onChange={(reducer) => onChange({ ...options, reducer })}
      />
      <SelectField
        id={`${id}-color`}
        label={t("panels.stat.colorMode")}
        value={options.colorMode}
        choices={COLOR_MODES.map((m) => [m, t(`panels.stat.colorMode.${m}`)])}
        onChange={(colorMode) => onChange({ ...options, colorMode })}
      />
      <SelectField
        id={`${id}-graph`}
        label={t("panels.stat.graphMode")}
        value={options.graphMode}
        choices={GRAPH_MODES.map((m) => [m, t(`panels.stat.graphMode.${m}`)])}
        onChange={(graphMode) => onChange({ ...options, graphMode })}
      />
      <SelectField
        id={`${id}-text`}
        label={t("panels.stat.textMode")}
        value={options.textMode}
        choices={TEXT_MODES.map((m) => [m, t(`panels.stat.textMode.${m}`)])}
        onChange={(textMode) => onChange({ ...options, textMode })}
      />
    </>
  );
}

export const statPanel: PanelPlugin<StatOptions> = {
  type: "stat",
  name: "dashboards.panels.stat",
  description: "panels.describe.stat",
  shapes: ["frame"],
  options: parseOptions,
  Panel: StatPanel,
  Editor: StatEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: StatPreview,
};
