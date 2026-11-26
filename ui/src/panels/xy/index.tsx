import { isRecord } from "../../api/client";
import { type Translate, useI18n } from "../../i18n/i18n";
import { EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import {
  type LegendOptions,
  parseLegend,
  parseTooltip,
  type TooltipOptions,
} from "../fieldConfig/legendOptions";
import { type FitAction, FitHint } from "../fitHint";
import { isNumeric } from "../frame";
import { XYPreview } from "../picker/previews";
import { EmptyPanel, emptyReason, NumberField, SelectField, TextField } from "../shared";
import type { PanelEditorProps, PanelField, PanelPlugin, PanelProps } from "../types";
import { XYChart } from "./XYChart";
import {
  buildXY,
  XY_SIZE,
  type XYFieldChoice,
  type XYMapping,
  type XYProblem,
  type XYShow,
} from "./xyData";

/**
 * The XY chart: two number fields against each other, a point per row
 * (docs/design/blueprint/XYMapTrend.dc.html, frames 1 and 2). It reads frames as they are;
 * documents and graphs need the visible projection step first.
 */
export interface XYOptions extends XYFieldChoice {
  sizeMin: number;
  sizeMax: number;
  show: XYShow;
  /** Fill strength of the points in percent. */
  pointOpacity: number;
  legend: LegendOptions;
  tooltip: TooltipOptions;
}

const MAX_FIELD_CHARS = 200;
export const XY_DEFAULTS = { sizeMin: 3, sizeMax: 9, pointOpacity: 55 } as const;
const OPACITY = { min: 5, max: 100 } as const;
const SHOWS: readonly XYShow[] = ["points", "lines", "both"];

function fieldName(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value.slice(0, MAX_FIELD_CHARS) : undefined;
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function parseXYOptions(stored: unknown): XYOptions {
  const value = isRecord(stored) ? stored : {};
  const options: XYOptions = {
    mapping: value.mapping === "manual" ? "manual" : "auto",
    sizeMin: bounded(value.sizeMin, XY_SIZE.min, XY_SIZE.max, XY_DEFAULTS.sizeMin),
    sizeMax: bounded(value.sizeMax, XY_SIZE.min, XY_SIZE.max, XY_DEFAULTS.sizeMax),
    show: SHOWS.find((s) => s === value.show) ?? "points",
    pointOpacity: bounded(value.pointOpacity, OPACITY.min, OPACITY.max, XY_DEFAULTS.pointOpacity),
    legend: parseLegend(value),
    tooltip: parseTooltip(value),
  };
  if (options.sizeMin > options.sizeMax) {
    options.sizeMax = options.sizeMin;
  }
  for (const key of ["x", "y", "seriesBy", "sizeBy", "colorBy"] as const) {
    const name = fieldName(value[key]);
    if (name !== undefined) options[key] = name;
  }
  return options;
}

/** The hint for data the chart cannot draw (frame 8 of the board, "Zwei Zahlfelder gesucht"). */
export function xyHint(
  t: Translate,
  problem: XYProblem,
): { title: string; text: string; actions: FitAction[] } {
  const bar: FitAction = { kind: "type", label: t("panels.trend.showAsBar"), type: "bar" };
  switch (problem.kind) {
    case "oneNumber":
      return {
        title: t("panels.xy.twoNumbers"),
        text: t("panels.xy.oneNumberText", { field: problem.field }),
        actions: [bar],
      };
    case "noNumbers":
      return { title: t("panels.xy.twoNumbers"), text: t("panels.xy.noNumbersText"), actions: [] };
    case "missing":
      return {
        title: t("panels.xy.missing"),
        text: t("panels.xy.missingText", { field: problem.field }),
        actions: [],
      };
  }
}

function XYPanel({
  frames,
  options,
  title,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<XYOptions>) {
  const { t } = useI18n();
  const reason = emptyReason(frames, "noValues");
  if (reason === "noData") {
    return <EmptyPanel reason={reason} />;
  }
  const data = buildXY(frames, options, fieldConfig, t("panels.xy.others"));
  if ("kind" in data) {
    const hint = xyHint(t, data);
    return <FitHint title={hint.title} text={hint.text} actions={hint.actions} />;
  }
  if (data.total === 0) {
    return <EmptyPanel reason="noValues" />;
  }
  return (
    <XYChart
      data={data}
      frames={frames}
      config={fieldConfig}
      show={options.show}
      sizes={options}
      opacity={options.pointOpacity / 100}
      seriesBy={options.seriesBy}
      title={title}
      legend={options.legend}
      tooltip={options.tooltip.mode}
    />
  );
}

/** A choice of a field by name from the preview, or a text field where there is no preview. */
function FieldPick({
  label,
  hint,
  value,
  names,
  empty,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  names: readonly string[];
  /** Offers "none" with this text. */
  empty?: string;
  onChange: (name: string) => void;
}) {
  if (names.length === 0) {
    return (
      <TextField
        label={label}
        {...(hint === undefined ? {} : { hint })}
        value={value ?? ""}
        maxLength={MAX_FIELD_CHARS}
        mono
        onChange={onChange}
      />
    );
  }
  const all = [...new Set([...names, ...(value === undefined ? [] : [value])])];
  return (
    <SelectField
      label={label}
      {...(hint === undefined ? {} : { hint })}
      value={value ?? ""}
      choices={[
        ...(empty === undefined ? [] : [["", empty] as const]),
        ...all.map((n) => [n, n] as const),
      ]}
      onChange={onChange}
    />
  );
}

function XYEditor({ options, onChange, fields = [] }: PanelEditorProps<XYOptions>) {
  const { t } = useI18n();
  const numbers = fields.filter((f: PanelField) => isNumeric(f.type)).map((f) => f.name);
  const keys = fields.filter((f) => f.type !== "json").map((f) => f.name);
  const set = (key: "x" | "y" | "seriesBy" | "sizeBy" | "colorBy", name: string) => {
    const { [key]: _, ...rest } = options;
    onChange(name === "" ? (rest as XYOptions) : { ...rest, [key]: name });
  };
  const autoX = numbers[0];
  return (
    <>
      <SelectField<XYMapping>
        label={t("panels.xy.mapping")}
        hint={t("panels.xy.mappingHint")}
        value={options.mapping}
        choices={[
          [
            "auto",
            autoX === undefined ? t("panels.xy.auto") : t("panels.xy.autoNamed", { field: autoX }),
          ],
          ["manual", t("panels.xy.manual")],
        ]}
        onChange={(mapping) =>
          onChange(
            mapping === "manual"
              ? {
                  ...options,
                  mapping,
                  x: options.x ?? numbers[0] ?? "",
                  y: options.y ?? numbers[1] ?? "",
                }
              : { ...options, mapping },
          )
        }
      />
      {options.mapping === "manual" ? (
        <>
          <FieldPick
            label={t("panels.xy.xField")}
            value={options.x}
            names={numbers}
            onChange={(name) => set("x", name)}
          />
          <FieldPick
            label={t("panels.xy.yField")}
            value={options.y}
            names={numbers}
            onChange={(name) => set("y", name)}
          />
        </>
      ) : null}
      <FieldPick
        label={t("panels.xy.seriesBy")}
        hint={t("panels.xy.seriesByHint")}
        value={options.seriesBy}
        names={keys}
        empty={t("panels.xy.none")}
        onChange={(name) => set("seriesBy", name)}
      />
      <FieldPick
        label={t("panels.xy.sizeBy")}
        value={options.sizeBy}
        names={numbers}
        empty={t("panels.xy.none")}
        onChange={(name) => set("sizeBy", name)}
      />
      <NumberField
        label={t("panels.xy.sizeMin")}
        value={options.sizeMin}
        min={XY_SIZE.min}
        max={XY_SIZE.max}
        step={1}
        onChange={(sizeMin) =>
          sizeMin !== undefined && Number.isInteger(sizeMin)
            ? onChange({ ...options, sizeMin, sizeMax: Math.max(sizeMin, options.sizeMax) })
            : undefined
        }
      />
      <NumberField
        label={t("panels.xy.sizeMax")}
        value={options.sizeMax}
        min={XY_SIZE.min}
        max={XY_SIZE.max}
        step={1}
        onChange={(sizeMax) =>
          sizeMax !== undefined && Number.isInteger(sizeMax)
            ? onChange({ ...options, sizeMax, sizeMin: Math.min(sizeMax, options.sizeMin) })
            : undefined
        }
      />
      <FieldPick
        label={t("panels.xy.colorBy")}
        hint={t("panels.xy.colorByHint")}
        value={options.colorBy}
        names={numbers}
        empty={t("panels.xy.colorBySeries")}
        onChange={(name) => set("colorBy", name)}
      />
      <SelectField<XYShow>
        label={t("panels.xy.show")}
        hint={t("panels.xy.showHint")}
        value={options.show}
        choices={[
          ["points", t("panels.xy.show.points")],
          ["lines", t("panels.xy.show.lines")],
          ["both", t("panels.xy.show.both")],
        ]}
        onChange={(show) => onChange({ ...options, show })}
      />
      <NumberField
        label={t("panels.xy.pointOpacity")}
        value={options.pointOpacity}
        min={OPACITY.min}
        max={OPACITY.max}
        step={1}
        onChange={(pointOpacity) =>
          pointOpacity !== undefined && Number.isInteger(pointOpacity)
            ? onChange({ ...options, pointOpacity })
            : undefined
        }
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

export const xyPanel: PanelPlugin<XYOptions> = {
  type: "xy",
  name: "panels.type.xy",
  description: "panels.describe.xy",
  shapes: ["frame"],
  options: parseXYOptions,
  Panel: XYPanel,
  Editor: XYEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "overrides"],
  Preview: XYPreview,
};
