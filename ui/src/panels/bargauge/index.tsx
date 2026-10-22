import { useId } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import {
  EMPTY_FIELD_CONFIG,
  type Tone,
  thresholdTone,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { readoutItems } from "../gauge";
import { BarGaugePreview } from "../picker/previews";
import { Readout } from "../readout";
import { fraction, type ReducedItem, reduceFrames } from "../reduce";
import { EmptyPanel, emptyReason, SelectField } from "../shared";
import { parseReducer, REDUCERS, type Reducer } from "../stat/reduce";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../viz.css";

export const DISPLAY_MODES = ["basic", "lcd"] as const;
export const ORIENTATIONS = ["horizontal", "vertical"] as const;

export interface BarGaugeOptions {
  reducer: Reducer;
  /** basic: one filled bar; lcd: lit cells, each in the color of its own threshold. */
  displayMode: (typeof DISPLAY_MODES)[number];
  orientation: (typeof ORIENTATIONS)[number];
}

function parseOptions(stored: unknown): BarGaugeOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    reducer: parseReducer(value.reducer),
    displayMode: DISPLAY_MODES.find((m) => m === value.displayMode) ?? "basic",
    orientation: ORIENTATIONS.find((o) => o === value.orientation) ?? "horizontal",
  };
}

/** Cells of the LCD mode. */
export const LCD_CELLS = 20;

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
      tone: thresholds === undefined ? color : thresholdTone(value, thresholds, item.range),
    };
  });
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
  const tone = item.display.tone ?? item.options.color;
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

function BarGaugePanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<BarGaugeOptions>) {
  const { t, language } = useI18n();
  const items = reduceFrames(frames, fieldConfig, options.reducer, language);
  // Without any row there is nothing to reduce, even when the fields are there.
  if (items.length === 0 || emptyReason(frames, "noValues") === "noData") {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  return (
    <Readout
      title={title}
      items={readoutItems(items, t)}
      tooltip="all"
      className={`bargauge bargauge--${options.orientation}`}
    >
      {(active, hover) => (
        <ul className="bargauge__list">
          {items.map((item, index) => (
            <li
              key={item.index}
              className={
                active === index ? "bargauge__item bargauge__item--active" : "bargauge__item"
              }
              onPointerEnter={() => hover(index)}
            >
              <span className="bargauge__name truncate">{item.name}</span>
              <Bar item={item} options={options} />
              <span className="bargauge__value">
                {item.display.text === "" ? "–" : item.display.text}
                {item.display.suffix === "" ? null : (
                  <span className="stat__unit">{`\u00a0${item.display.suffix}`}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
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
