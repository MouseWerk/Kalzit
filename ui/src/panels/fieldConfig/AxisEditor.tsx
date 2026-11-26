import { useI18n } from "../../i18n/i18n";
import { AXIS_SCALES, type AxisScale, LOG_BASES, type LogBase } from "../axisScale";
import { CheckboxField, NumberField, SelectField, TextField } from "../shared";
import {
  AXIS_COLORS,
  AXIS_GRIDS,
  AXIS_LIMITS,
  AXIS_PLACEMENTS,
  type AxisColor,
  type AxisGrid,
  type AxisOptions,
  type AxisPlacement,
} from "./axisOptions";
import type { FieldOptions } from "./fieldConfig";

/**
 * The group "Achsen" (ParityEditors board, frame 2): placement, label, width, grid lines, colour
 * and line of the axis, its scale (linear, logarithmic with base 2 or 10, log around zero), zero
 * in the middle and soft limits. Every "Auto" says what it picks. Unset options stay automatic.
 */
export function AxisEditor({
  options,
  onChange,
}: {
  options: FieldOptions;
  onChange: (options: FieldOptions) => void;
}) {
  const { t } = useI18n();
  const set = <K extends keyof AxisOptions>(key: K, value: AxisOptions[K] | undefined) => {
    const next = { ...options };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value as FieldOptions[K];
    }
    onChange(next);
  };
  const scale = options.axisScale ?? "linear";
  return (
    <>
      <SelectField<AxisPlacement>
        label={t("panels.axis.placement")}
        hint={t("panels.axis.placementHint")}
        value={options.axisPlacement ?? "auto"}
        choices={AXIS_PLACEMENTS.map((p) => [p, t(`panels.axis.placement.${p}`)] as const)}
        onChange={(p) => set("axisPlacement", p === "auto" ? undefined : p)}
      />
      <TextField
        label={t("panels.axis.label")}
        hint={t("panels.axis.labelHint")}
        value={options.axisLabel ?? ""}
        maxLength={AXIS_LIMITS.labelChars}
        onChange={(label) => set("axisLabel", label.trim() === "" ? undefined : label)}
      />
      <NumberField
        label={t("panels.axis.width")}
        hint={t("panels.axis.widthHint")}
        placeholder={t("panels.graph.auto")}
        value={options.axisWidth}
        min={AXIS_LIMITS.minWidth}
        max={AXIS_LIMITS.maxWidth}
        step={1}
        onChange={(width) =>
          width === undefined || Number.isInteger(width) ? set("axisWidth", width) : undefined
        }
      />
      <SelectField<AxisGrid>
        label={t("panels.axis.grid")}
        hint={t("panels.axis.gridHint")}
        value={options.axisGrid ?? "auto"}
        choices={AXIS_GRIDS.map((g) => [g, t(`panels.axis.grid.${g}`)] as const)}
        onChange={(g) => set("axisGrid", g === "auto" ? undefined : g)}
      />
      <SelectField<AxisColor>
        label={t("panels.axis.color")}
        value={options.axisColor ?? "text"}
        choices={AXIS_COLORS.map((c) => [c, t(`panels.axis.color.${c}`)] as const)}
        onChange={(c) => set("axisColor", c === "text" ? undefined : c)}
      />
      <CheckboxField
        label={t("panels.axis.line")}
        checked={options.axisLine === true}
        onChange={(line) => set("axisLine", line ? true : undefined)}
      />
      <SelectField<AxisScale>
        label={t("panels.axis.scale")}
        value={scale}
        choices={AXIS_SCALES.map((s) => [s, t(`panels.axis.scale.${s}`)] as const)}
        onChange={(s) => set("axisScale", s === "linear" ? undefined : s)}
      />
      {scale === "linear" ? null : (
        <SelectField<`${LogBase}`>
          label={t("panels.axis.base")}
          hint={t("panels.axis.baseHint")}
          value={`${options.axisLogBase ?? 10}`}
          choices={LOG_BASES.map((b) => [`${b}`, String(b)] as const)}
          onChange={(b) => set("axisLogBase", b === "10" ? undefined : (Number(b) as LogBase))}
        />
      )}
      {scale === "log" ? null : (
        <CheckboxField
          label={t("panels.axis.centeredZero")}
          checked={options.axisCenteredZero === true}
          onChange={(centered) => set("axisCenteredZero", centered ? true : undefined)}
        />
      )}
      <NumberField
        label={t("panels.axis.softMin")}
        value={options.axisSoftMin}
        onChange={(v) => set("axisSoftMin", v)}
      />
      <NumberField
        label={t("panels.axis.softMax")}
        hint={t("panels.axis.softHint")}
        value={options.axisSoftMax}
        onChange={(v) => set("axisSoftMax", v)}
      />
    </>
  );
}
