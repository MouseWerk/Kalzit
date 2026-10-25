import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import type { Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import {
  displayValue,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
  fieldOptionsFor,
  type Tone,
  thresholdTone,
  toneClass,
  toneOf,
} from "../fieldConfig/fieldConfig";
import { formatValue, rowCount, valueFields } from "../frame";
import { readoutItems } from "../gauge";
import { labelWidth } from "../measure";
import { BarGaugePreview } from "../picker/previews";
import { Readout } from "../readout";
import { defaultRange, fraction, type ReducedItem, reduceFrames } from "../reduce";
import { EmptyPanel, emptyReason, SelectField } from "../shared";
import { parseReducer, REDUCERS, type Reducer, reduceField } from "../stat/reduce";
import { useStyleVars } from "../styleVars";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../viz.css";

export const DISPLAY_MODES = ["basic", "lcd"] as const;
export const ORIENTATIONS = ["horizontal", "vertical"] as const;
/** The value after each bar: in the text color, in the bar's color, or not shown. */
export const VALUE_DISPLAYS = ["text", "color", "hidden"] as const;
/** Each bar's name: before the bar, on a line above it, or not shown. */
export const NAME_PLACEMENTS = ["left", "top", "hidden"] as const;

export interface BarGaugeOptions {
  reducer: Reducer;
  /** basic: one filled bar; lcd: lit cells, each in the color of its own threshold. */
  displayMode: (typeof DISPLAY_MODES)[number];
  orientation: (typeof ORIENTATIONS)[number];
  valueDisplay: (typeof VALUE_DISPLAYS)[number];
  namePlacement: (typeof NAME_PLACEMENTS)[number];
}

function parseOptions(stored: unknown): BarGaugeOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    reducer: parseReducer(value.reducer),
    displayMode: DISPLAY_MODES.find((m) => m === value.displayMode) ?? "basic",
    orientation: ORIENTATIONS.find((o) => o === value.orientation) ?? "horizontal",
    valueDisplay: VALUE_DISPLAYS.find((v) => v === value.valueDisplay) ?? "text",
    namePlacement: NAME_PLACEMENTS.find((p) => p === value.namePlacement) ?? "left",
  };
}

/** Cells of the LCD mode. */
export const LCD_CELLS = 20;
/** Bars beyond this many rows are left out with a note: each must stay a readable line. */
export const MAX_GAUGE_ROWS = 100;

export interface GaugeItems {
  items: ReducedItem[];
  /** Rows beyond MAX_GAUGE_ROWS were left out. */
  truncated: boolean;
  /** Bars come from the rows of one result; further results with values are not shown. */
  dropped: boolean;
}

/**
 * The bars: a result of categories (a text field, no time, several rows) gives one bar per row
 * of its first value field, named by the text, all on the field's range, as the pie takes its
 * slices; otherwise one bar per value field, reduced.
 */
export function gaugeItems(
  frames: readonly Frame[],
  config: FieldConfig,
  reducer: Reducer,
  language: string,
  zone: string | null,
): GaugeItems {
  const byRow = frames.find(
    (f) =>
      rowCount(f) > 1 &&
      f.fields.some((field) => field.type === "string") &&
      !f.fields.some((field) => field.type === "time" || field.type === "date") &&
      valueFields(f).length > 0,
  );
  const label = byRow?.fields.find((field) => field.type === "string");
  const field = byRow === undefined ? undefined : valueFields(byRow)[0];
  if (byRow === undefined || label === undefined || field === undefined) {
    const items = onOneScale(
      reduceFrames(frames, config, reducer, language, zone),
      reducer,
      language,
      zone,
    );
    return { items, truncated: false, dropped: false };
  }
  const options = fieldOptionsFor(field, config);
  const range = defaultRange(field, options);
  const count = Math.min(rowCount(byRow), MAX_GAUGE_ROWS);
  const items = Array.from({ length: count }, (_, row) => ({
    frame: byRow,
    field,
    options,
    name: formatValue(label.type, label.values[row], language, zone),
    type: field.type,
    display: displayValue(field.values[row], field.type, options, language, range, zone),
    range,
    index: row,
  }));
  return {
    items,
    truncated: rowCount(byRow) > MAX_GAUGE_ROWS,
    dropped:
      valueFields(byRow).length > 1 ||
      frames.some((f) => f !== byRow && valueFields(f).length > 0 && rowCount(f) > 0),
  };
}

/** Units whose range is fixed by the unit itself (0 to 100, 0 to 1), never shared with others. */
const OWN_RANGE_UNITS = new Set(["percent", "percentunit"]);

/**
 * Bars side by side are compared, so fields of the same unit without a min or max of their own
 * share one scale: from the lowest to the highest of their ranges. Otherwise each field would
 * fill its own bar (a reduced last value is often its field's maximum) and every bar would look
 * full. Fields of different units are never put on one scale (60 % next to 6 GB would leave the
 * percent bar empty), and percentages keep their own 0 to 100.
 */
function onOneScale(
  items: ReducedItem[],
  reducer: Reducer,
  language: string,
  zone: string | null,
): ReducedItem[] {
  const groups = new Map<string, ReducedItem[]>();
  for (const item of items) {
    const unit = item.options.unit ?? "";
    if (item.options.min !== undefined || item.options.max !== undefined) continue;
    if (OWN_RANGE_UNITS.has(unit)) continue;
    groups.set(unit, [...(groups.get(unit) ?? []), item]);
  }
  const shared = new Map<ReducedItem, { min: number; max: number }>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const min = Math.min(...group.map((item) => item.range.min));
    // A sum can pass the largest single value, which is where a field's own range ends.
    const max = Math.max(...group.flatMap((item) => [item.range.max, item.display.numeric ?? 0]));
    for (const item of group) shared.set(item, { min, max });
  }
  return items.map((item) => {
    const range = shared.get(item);
    if (range === undefined) {
      return item;
    }
    // The thresholds in percent read the range, so the value is shown again on the shared one.
    const display =
      item.display.numeric === null
        ? item.display
        : displayValue(
            reduceField(item.field, reducer).value,
            item.type,
            item.options,
            language,
            range,
            zone,
          );
    return { ...item, range, display };
  });
}

/**
 * The cells of an LCD bar: lit up to the value, each lit cell in the tone the thresholds give
 * the value at the cell's middle, so the bar shows where the thresholds lie.
 */
export function lcdCells(item: ReducedItem): { lit: boolean; tone: Tone | undefined }[] {
  const share = item.display.numeric === null ? 0 : fraction(item.display.numeric, item.range);
  const { thresholds, color } = item.options;
  return Array.from({ length: LCD_CELLS }, (_, i) => {
    const middle = (i + 0.5) / LCD_CELLS;
    const value = item.range.min + middle * (item.range.max - item.range.min);
    return {
      lit: middle <= share || (i === 0 && share > 0),
      tone: thresholds === undefined ? toneOf(color) : thresholdTone(value, thresholds, item.range),
    };
  });
}

/** The least and largest height of a horizontal bar gauge's row, in px. */
const ROW_MIN = 20;
const ROW_MAX = 40;
/** Spare room after the widest value: canvas measuring may run before the web font is drawn. */
const VALUE_SLACK = 4;

/**
 * Lengths the layout takes from the stylesheet, in px: the gap between rows, the line of a name
 * above its bar, and the gap between a bar's end and its value. Read once the rows are drawn;
 * until then (and where nothing is laid out, as in the tests) these stand in for them.
 */
export interface GaugeMetrics {
  rowGap: number;
  nameLine: number;
  valueGap: number;
}

export const FALLBACK_METRICS: GaugeMetrics = { rowGap: 8, nameLine: 18, valueGap: 8 };

/**
 * Row and bar height of a horizontal bar gauge: the rows share the panel's height between a
 * least and a largest height, and the value text is sized to the bar (in CSS, from these).
 */
export function gaugeRows(
  height: number,
  count: number,
  namePlacement: BarGaugeOptions["namePlacement"],
  metrics: GaugeMetrics = FALLBACK_METRICS,
): { row: number; bar: number } {
  const shared = count > 0 ? (height - metrics.rowGap * (count - 1)) / count : height;
  const name = namePlacement === "top" ? metrics.nameLine : 0;
  const row = Math.floor(Math.min(Math.max(shared, ROW_MIN + name), ROW_MAX + name));
  return { row, bar: row - name };
}

/**
 * The value's type size for a bar of this height in px: about half the row, in the
 * steps of the type scale, from the body size up.
 */
export function valueSize(bar: number): "sm" | "md" | "lg" | "xl" {
  if (bar >= 34) return "xl";
  if (bar >= 28) return "lg";
  if (bar >= 23) return "md";
  return "sm";
}

function Bar({ item, options }: { item: ReducedItem; options: BarGaugeOptions }) {
  const vertical = options.orientation === "vertical";
  const share = item.display.numeric === null ? 0 : fraction(item.display.numeric, item.range);
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  if (options.displayMode === "lcd") {
    const cells = lcdCells(item);
    const size = 1 / LCD_CELLS;
    return (
      <svg className="bargauge__svg" preserveAspectRatio="none" aria-hidden="true">
        {cells.map((cell, i) => {
          const offset = vertical ? 1 - (i + 1) * size : i * size;
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are fixed positions
              key={i}
              className={
                cell.lit
                  ? `bargauge__cell ${toneClass(cell.tone, item.index)}`
                  : "bargauge__cell bargauge__cell--off"
              }
              x={vertical ? "0" : percent(offset + size * 0.08)}
              y={vertical ? percent(offset + size * 0.08) : "0"}
              width={vertical ? "100%" : percent(size * 0.84)}
              height={vertical ? percent(size * 0.84) : "100%"}
            />
          );
        })}
      </svg>
    );
  }
  const tone = item.display.tone ?? toneOf(item.options.color);
  return (
    <svg className="bargauge__svg" preserveAspectRatio="none" aria-hidden="true">
      <rect className="bargauge__track" x="0" y="0" width="100%" height="100%" />
      {share > 0 ? (
        <rect
          className={`bargauge__fill ${toneClass(tone, item.index)}`}
          x="0"
          y={vertical ? percent(1 - share) : "0"}
          width={vertical ? "100%" : percent(share)}
          height={vertical ? percent(share) : "100%"}
        />
      ) : null}
    </svg>
  );
}

const px = (value: string) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : undefined;
};

/**
 * The values' font and the layout's lengths, read from the drawn list and its probes. Read
 * again when the value's size step changes; the body mounts only with rows, so the list is
 * there the first time this runs.
 */
function useGaugeMetrics(
  list: RefObject<HTMLElement | null>,
  valueProbe: RefObject<HTMLElement | null>,
  nameProbe: RefObject<HTMLElement | null>,
  size: string | undefined,
): { font: string | null; metrics: GaugeMetrics } {
  const [read, setRead] = useState<{ font: string | null; metrics: GaugeMetrics }>({
    font: null,
    metrics: FALLBACK_METRICS,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the size step changes the probe's font
  useLayoutEffect(() => {
    const listElement = list.current;
    const value = valueProbe.current;
    if (listElement === null || value === null) {
      return;
    }
    const valueStyle = getComputedStyle(value);
    const lane = listElement.querySelector(".bargauge__lane");
    const nameHeight = nameProbe.current?.getBoundingClientRect().height ?? 0;
    setRead({
      font: `${valueStyle.fontWeight} ${valueStyle.fontSize} ${valueStyle.fontFamily}`,
      metrics: {
        rowGap: px(getComputedStyle(listElement).rowGap) ?? FALLBACK_METRICS.rowGap,
        nameLine: nameHeight > 0 ? Math.ceil(nameHeight) : FALLBACK_METRICS.nameLine,
        valueGap:
          (lane === null ? undefined : px(getComputedStyle(lane).columnGap)) ??
          FALLBACK_METRICS.valueGap,
      },
    });
  }, [list, valueProbe, nameProbe, size]);
  return read;
}

/** A bar of the lane layout: as long as its share of what is left after the widest value. */
function LaneFill({ share, className }: { share: number; className: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useStyleVars(ref, { "--share": share });
  return (
    <svg className="bargauge__lane-bar" ref={ref} aria-hidden="true">
      <rect className={className} x="0" y="0" width="100%" height="100%" rx="2" />
    </svg>
  );
}

function BarGaugePanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<BarGaugeOptions>) {
  const { language, timeZone } = useI18n();
  const gauge = gaugeItems(frames, fieldConfig, options.reducer, language, timeZone);
  // Without any row there is nothing to reduce, even when the fields are there.
  if (gauge.items.length === 0 || emptyReason(frames, "noValues") === "noData") {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  return <GaugeBody gauge={gauge} options={options} title={title} />;
}

/**
 * The drawn gauge, a component of its own: it mounts with its rows, so its size and font are
 * measured from the start even when the panel first showed no data.
 */
function GaugeBody({
  gauge,
  options,
  title,
}: {
  gauge: GaugeItems;
  options: BarGaugeOptions;
  title: string;
}) {
  const { t } = useI18n();
  const { items } = gauge;
  const listRef = useRef<HTMLUListElement>(null);
  const valueProbeRef = useRef<HTMLSpanElement>(null);
  const nameProbeRef = useRef<HTMLSpanElement>(null);
  const { height } = useElementSize(listRef);
  const [size, setSize] = useState<ReturnType<typeof valueSize> | undefined>(undefined);
  const { font, metrics } = useGaugeMetrics(listRef, valueProbeRef, nameProbeRef, size);
  const { row, bar } = gaugeRows(height, items.length, options.namePlacement, metrics);
  const nextSize = options.orientation === "horizontal" ? valueSize(bar) : undefined;
  if (nextSize !== size) {
    setSize(nextSize);
  }
  // Horizontal bars in the basic style stand on no track: each value follows its bar's end, and
  // the longest bar leaves room for the widest value.
  const lane = options.orientation === "horizontal" && options.displayMode === "basic";
  const shownValue = (item: ReducedItem) => (item.display.text === "" ? "–" : item.display.text);
  const widest =
    !lane || options.valueDisplay === "hidden"
      ? 0
      : Math.max(
          0,
          ...items.map((item) =>
            labelWidth(
              item.display.suffix === ""
                ? shownValue(item)
                : `${shownValue(item)} ${item.display.suffix}`,
              font,
            ),
          ),
        );
  const valueRoom = widest === 0 ? 0 : Math.ceil(widest) + metrics.valueGap + VALUE_SLACK;
  useStyleVars(listRef, {
    "--bargauge-row": `${row}px`,
    "--bargauge-value-room": `${valueRoom}px`,
  });
  return (
    <Readout
      title={title}
      items={readoutItems(items, t)}
      tooltip="all"
      className={`bargauge bargauge--${options.orientation} bargauge--name-${options.namePlacement}${lane ? " bargauge--lane" : ""}`}
    >
      {(active, hover) => (
        <div className="bargauge__box" data-value-size={nextSize}>
          <ul className="bargauge__list" ref={listRef}>
            {items.map((item, index) => {
              const tone = item.display.tone ?? toneOf(item.options.color);
              const share =
                item.display.numeric === null ? 0 : fraction(item.display.numeric, item.range);
              const value =
                options.valueDisplay === "hidden" ? null : (
                  <span
                    className={
                      options.valueDisplay === "color"
                        ? `bargauge__value bargauge__value--color ${toneClass(tone, item.index)}`
                        : "bargauge__value"
                    }
                  >
                    {shownValue(item)}
                    {item.display.suffix === "" ? null : (
                      <span className="bargauge__unit">{` ${item.display.suffix}`}</span>
                    )}
                  </span>
                );
              return (
                <li
                  key={item.index}
                  className={
                    active === index ? "bargauge__item bargauge__item--active" : "bargauge__item"
                  }
                  onPointerEnter={() => hover(index)}
                >
                  {options.namePlacement === "hidden" ? null : (
                    <span className="bargauge__name truncate" title={item.name}>
                      {item.name}
                    </span>
                  )}
                  {lane ? (
                    <div className="bargauge__lane">
                      {share > 0 ? (
                        <LaneFill
                          share={share}
                          className={`bargauge__fill ${toneClass(tone, item.index)}`}
                        />
                      ) : null}
                      {value}
                    </div>
                  ) : (
                    <>
                      <Bar item={item} options={options} />
                      {value}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {/* Measure the values at their drawn size and a name's line, from the stylesheet. */}
          <span
            className="bargauge__probe bargauge__probe--value"
            ref={valueProbeRef}
            aria-hidden="true"
          />
          <span className="bargauge__probe" ref={nameProbeRef} aria-hidden="true">
            M
          </span>
          {gauge.truncated ? (
            <p className="panel-note">
              {t("panels.bargauge.truncated", { count: MAX_GAUGE_ROWS })}
            </p>
          ) : null}
          {gauge.dropped ? <p className="panel-note">{t("panels.bargauge.dropped")}</p> : null}
        </div>
      )}
    </Readout>
  );
}

function BarGaugeEditor({ options, onChange }: PanelEditorProps<BarGaugeOptions>) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <SelectField
        id={`${id}-reducer`}
        label={t("dashboards.panels.reducer")}
        hint={t("panels.bargauge.reducerHint")}
        value={options.reducer}
        choices={REDUCERS.map((r) => [r, t(`dashboards.panels.reducer.${r}`)])}
        onChange={(reducer) => onChange({ ...options, reducer })}
      />
      <SelectField
        id={`${id}-mode`}
        label={t("panels.bargauge.displayMode")}
        value={options.displayMode}
        choices={DISPLAY_MODES.map((m) => [m, t(`panels.bargauge.displayMode.${m}`)])}
        onChange={(displayMode) => onChange({ ...options, displayMode })}
      />
      <SelectField
        id={`${id}-orientation`}
        label={t("panels.orientation")}
        value={options.orientation}
        choices={ORIENTATIONS.map((o) => [o, t(`panels.orientation.${o}`)])}
        onChange={(orientation) => onChange({ ...options, orientation })}
      />
      <SelectField
        id={`${id}-value`}
        label={t("panels.bargauge.valueDisplay")}
        value={options.valueDisplay}
        choices={VALUE_DISPLAYS.map((v) => [v, t(`panels.bargauge.valueDisplay.${v}`)])}
        onChange={(valueDisplay) => onChange({ ...options, valueDisplay })}
      />
      <SelectField
        id={`${id}-name`}
        label={t("panels.bargauge.namePlacement")}
        value={options.namePlacement}
        choices={NAME_PLACEMENTS.map((p) => [p, t(`panels.bargauge.namePlacement.${p}`)])}
        onChange={(namePlacement) => onChange({ ...options, namePlacement })}
      />
    </>
  );
}

export const barGaugePanel: PanelPlugin<BarGaugeOptions> = {
  type: "bargauge",
  name: "panels.type.bargauge",
  description: "panels.describe.bargauge",
  shapes: ["frame"],
  options: parseOptions,
  Panel: BarGaugePanel,
  Editor: BarGaugeEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: BarGaugePreview,
};
