import { useId } from "react";
import { isRecord } from "../../api/client";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import {
  displayText,
  EMPTY_FIELD_CONFIG,
  type Thresholds,
  thresholdTone,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { GaugePreview } from "../picker/previews";
import { Readout, type ReadoutItem } from "../readout";
import { fraction, type ReducedItem, reduceFrames, toneName } from "../reduce";
import { CheckboxField, EmptyPanel, emptyReason, SelectField } from "../shared";
import { parseReducer, REDUCERS, type Reducer } from "../stat/reduce";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../viz.css";

export interface GaugeOptions {
  reducer: Reducer;
  /** A thin ring outside the arc with the threshold colors. */
  showThresholdMarkers: boolean;
}

function parseOptions(stored: unknown): GaugeOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    reducer: parseReducer(value.reducer),
    showThresholdMarkers: value.showThresholdMarkers !== false,
  };
}

/** The arc runs 240 degrees, from lower left over the top to lower right. */
const SWEEP = 240;
const START = -SWEEP / 2;
const CX = 100;
const CY = 100;
const RADIUS = 76;
const MARKER_RADIUS = 92;

function point(radius: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [CX + radius * Math.sin(radians), CY - radius * Math.cos(radians)];
}

/** An SVG arc path from one angle to another (degrees clockwise from twelve o'clock). */
export function arcPath(radius: number, from: number, to: number): string {
  const [x0, y0] = point(radius, from);
  const [x1, y1] = point(radius, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** The threshold steps as arcs over the range: [from angle, to angle, tone]. */
export function thresholdBands(
  thresholds: Thresholds,
  range: { min: number; max: number },
): { from: number; to: number; tone: Thresholds["steps"][number]["tone"] }[] {
  const span = range.max - range.min || 1;
  const angle = (value: number) => START + SWEEP * Math.min(Math.max(value, 0), 1);
  const edges = thresholds.steps.map((step, index) => {
    if (index === 0 || step.value === null) return 0;
    return thresholds.mode === "percentage" ? step.value / 100 : (step.value - range.min) / span;
  });
  return thresholds.steps
    .map((step, index) => ({
      from: angle(edges[index] ?? 0),
      to: angle(edges[index + 1] ?? 1),
      tone: step.tone,
    }))
    .filter((band) => band.to > band.from);
}

function Gauge({
  item,
  active,
  markers,
}: {
  item: ReducedItem;
  active: boolean;
  markers: boolean;
}) {
  const { display, range, options } = item;
  const share = display.numeric === null ? 0 : fraction(display.numeric, range);
  const tone =
    display.tone ??
    (display.numeric !== null && options.thresholds !== undefined
      ? thresholdTone(display.numeric, options.thresholds, range)
      : options.color);
  const end = START + SWEEP * share;
  return (
    <svg className="gauge__svg" viewBox="0 0 200 170" aria-hidden="true">
      {!markers || options.thresholds === undefined
        ? null
        : thresholdBands(options.thresholds, range).map((band) => (
            <path
              key={`${band.from}-${band.tone}`}
              className={`gauge__marker ${toneClass(band.tone)}`}
              d={arcPath(MARKER_RADIUS, band.from, band.to)}
            />
          ))}
      <path className="gauge__track" d={arcPath(RADIUS, START, START + SWEEP)} />
      {share > 0 ? (
        <path
          className={`gauge__value-arc ${toneClass(tone, item.index)}`}
          d={arcPath(RADIUS, START, end)}
        />
      ) : null}
      <text
        className={active ? "gauge__text gauge__text--active" : "gauge__text"}
        x={CX}
        y={CY + 4}
        textAnchor="middle"
      >
        {display.text === "" ? "–" : display.text}
        {display.suffix === "" ? null : (
          <tspan className="gauge__unit">{` ${display.suffix}`}</tspan>
        )}
      </text>
    </svg>
  );
}

/** Rows of the readout for reduced values, with the state named where a tone says one. */
export function readoutItems(
  items: readonly ReducedItem[],
  t: (key: MessageKey) => string,
): ReadoutItem[] {
  return items.map((item) => {
    const state = toneName(item.display.tone);
    const text =
      item.display.text === "" ? t("dashboards.panels.noValue") : displayText(item.display);
    return {
      label: "",
      rows: [
        {
          name: item.name,
          value: state === undefined ? text : `${text} (${t(state)})`,
          colorClass: toneClass(item.display.tone ?? item.options.color, item.index),
        },
      ],
    };
  });
}

function GaugePanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<GaugeOptions>) {
  const { t, language } = useI18n();
  const items = reduceFrames(frames, fieldConfig, options.reducer, language);
  if (items.length === 0) {
    return <EmptyPanel reason={emptyReason(frames, "noValues")} />;
  }
  return (
    <Readout title={title} items={readoutItems(items, t)} tooltip="all" className="gauge">
      {(active, hover) => (
        <ul className="gauge__list">
          {items.map((item, index) => (
            <li key={item.index} className="gauge__item" onPointerEnter={() => hover(index)}>
              <Gauge item={item} active={active === index} markers={options.showThresholdMarkers} />
              {items.length > 1 ? <span className="gauge__name truncate">{item.name}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Readout>
  );
}

function GaugeEditor({ options, onChange }: PanelEditorProps<GaugeOptions>) {
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
      <CheckboxField
        label={t("panels.gauge.markers")}
        checked={options.showThresholdMarkers}
        onChange={(showThresholdMarkers) => onChange({ ...options, showThresholdMarkers })}
      />
    </>
  );
}

export const gaugePanel: PanelPlugin<GaugeOptions> = {
  type: "gauge",
  name: "panels.type.gauge",
  description: "panels.describe.gauge",
  shapes: ["frame"],
  options: parseOptions,
  Panel: GaugePanel,
  Editor: GaugeEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: GaugePreview,
};
