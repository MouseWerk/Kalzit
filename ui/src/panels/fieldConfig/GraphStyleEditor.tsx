import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { CheckboxField, NumberField, SelectField, TextField } from "../shared";
import type { FieldOptions } from "./fieldConfig";
import {
  BAR_ALIGNMENTS,
  CONNECT_GAPS,
  DRAW_STYLES,
  FILLS,
  formatDuration,
  GRADIENTS,
  GRAPH_LIMITS,
  INTERPOLATIONS,
  LINE_STYLES,
  parseDuration,
  SHOW_POINTS,
  STACKINGS,
} from "./graphStyle";

/** A select whose first choice, "Auto", leaves the option unset. */
function AutoSelect<T extends string>({
  label,
  hint,
  value,
  choices,
  autoLabel,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T | undefined;
  choices: readonly (readonly [T, string])[];
  autoLabel: string;
  onChange: (value: T | undefined) => void;
}) {
  return (
    <SelectField<T | "">
      label={label}
      {...(hint === undefined ? {} : { hint })}
      value={value ?? ""}
      choices={[["", autoLabel], ...choices]}
      onChange={(next) => onChange(next === "" ? undefined : next)}
    />
  );
}

/**
 * A duration typed as "30s", "5m" or "1h"; empty leaves it unset. Text that is not a duration
 * yet stays in the field with a message and changes nothing.
 */
function DurationField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | undefined;
  onChange: (ms: number | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(value === undefined ? "" : formatDuration(value));
  const parsed = text.trim() === "" ? undefined : parseDuration(text);
  // A value changed elsewhere (an undo, a reset) shows instead of the typed text.
  const shown =
    parsed === null || parsed === value ? text : value === undefined ? "" : formatDuration(value);
  const invalid = parsed === null && shown === text;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
      <input
        id={id}
        className="input input--mono"
        value={shown}
        aria-describedby={invalid ? `${id}-hint ${id}-error` : `${id}-hint`}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          const ms = next.trim() === "" ? undefined : parseDuration(next);
          if (ms !== null) onChange(ms);
        }}
      />
      {invalid ? (
        <p className="field__error" id={`${id}-error`} role="alert">
          {t("panels.graph.durationInvalid")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The graph style of the time series: draw style, line, fill, points, gaps, stacking and bars.
 * Unset options are automatic (the monochrome look for a lone series); options that do not
 * apply to the chosen draw style are hidden.
 */
export function GraphStyleEditor({
  options,
  onChange,
}: {
  options: FieldOptions;
  onChange: (options: FieldOptions) => void;
}) {
  const { t } = useI18n();
  const auto = t("panels.graph.auto");
  const set = <K extends keyof FieldOptions>(key: K, value: FieldOptions[K] | undefined) => {
    const next = { ...options };
    if (value === undefined || value === "") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  };
  const draw = options.drawStyle ?? "line";
  const fill = options.fill;
  const stacked = options.stack !== undefined && options.stack !== "none";
  const L = GRAPH_LIMITS;
  return (
    <>
      <AutoSelect
        label={t("panels.graph.drawStyle")}
        value={options.drawStyle}
        autoLabel={t("panels.graph.drawStyle.auto")}
        choices={DRAW_STYLES.map((d) => [d, t(`panels.graph.drawStyle.${d}`)])}
        onChange={(drawStyle) => set("drawStyle", drawStyle)}
      />
      {draw === "line" ? (
        <>
          <AutoSelect
            label={t("panels.graph.interpolation")}
            value={options.lineInterpolation}
            autoLabel={t("panels.graph.interpolation.auto")}
            choices={INTERPOLATIONS.map((i) => [i, t(`panels.graph.interpolation.${i}`)])}
            onChange={(lineInterpolation) => set("lineInterpolation", lineInterpolation)}
          />
          <AutoSelect
            label={t("panels.graph.lineStyle")}
            value={options.lineStyle}
            autoLabel={t("panels.graph.lineStyle.auto")}
            choices={LINE_STYLES.map((s) => [s, t(`panels.graph.lineStyle.${s}`)])}
            onChange={(lineStyle) => set("lineStyle", lineStyle)}
          />
        </>
      ) : null}
      {draw === "points" ? null : (
        <NumberField
          label={t("panels.graph.lineWidth")}
          hint={t("panels.graph.lineWidthHint")}
          placeholder={auto}
          value={options.lineWidth}
          min={0}
          max={L.maxLineWidth}
          step={1}
          onChange={(width) =>
            width === undefined || Number.isInteger(width) ? set("lineWidth", width) : undefined
          }
        />
      )}
      {draw === "points" ? null : (
        <AutoSelect
          label={t("panels.graph.fill")}
          value={fill}
          autoLabel={t("panels.graph.fill.auto")}
          choices={FILLS.map((f) => [f, t(`panels.graph.fill.${f}`)])}
          onChange={(next) => set("fill", next)}
        />
      )}
      {draw === "points" || fill === "none" ? null : (
        <>
          <NumberField
            label={t("panels.graph.fillOpacity")}
            hint={t("panels.graph.fillOpacityHint")}
            placeholder={auto}
            value={options.fillOpacity}
            min={0}
            max={100}
            step={1}
            onChange={(opacity) =>
              opacity === undefined || Number.isInteger(opacity)
                ? set("fillOpacity", opacity)
                : undefined
            }
          />
          <AutoSelect
            label={t("panels.graph.gradient")}
            hint={t("panels.graph.gradientHint")}
            value={options.gradientMode}
            autoLabel={t("panels.graph.gradient.auto")}
            choices={GRADIENTS.map((g) => [g, t(`panels.graph.gradient.${g}`)])}
            onChange={(gradientMode) => set("gradientMode", gradientMode)}
          />
        </>
      )}
      <AutoSelect
        label={t("panels.graph.showPoints")}
        value={options.showPoints}
        autoLabel={t("panels.graph.showPoints.default")}
        choices={SHOW_POINTS.map((p) => [p, t(`panels.graph.showPoints.${p}`)])}
        onChange={(showPoints) => set("showPoints", showPoints)}
      />
      {options.showPoints === "never" && draw !== "points" ? null : (
        <NumberField
          label={t("panels.graph.pointSize")}
          placeholder="5"
          value={options.pointSize}
          min={L.minPointSize}
          max={L.maxPointSize}
          step={1}
          onChange={(size) =>
            size === undefined || Number.isInteger(size) ? set("pointSize", size) : undefined
          }
        />
      )}
      {draw === "bars" ? (
        <>
          <AutoSelect
            label={t("panels.graph.barAlignment")}
            value={options.barAlignment}
            autoLabel={t("panels.graph.barAlignment.auto")}
            choices={BAR_ALIGNMENTS.map((a) => [a, t(`panels.graph.barAlignment.${a}`)])}
            onChange={(barAlignment) => set("barAlignment", barAlignment)}
          />
          <NumberField
            label={t("panels.graph.barWidth")}
            hint={t("panels.graph.barWidthHint")}
            placeholder="60"
            value={options.barWidth}
            min={L.minBarWidth}
            max={L.maxBarWidth}
            step={1}
            onChange={(width) =>
              width === undefined || Number.isInteger(width) ? set("barWidth", width) : undefined
            }
          />
        </>
      ) : (
        <>
          <AutoSelect
            label={t("panels.graph.connectGaps")}
            value={options.connectGaps}
            autoLabel={t("panels.graph.connectGaps.auto")}
            choices={CONNECT_GAPS.map((c) => [c, t(`panels.graph.connectGaps.${c}`)])}
            onChange={(connectGaps) => set("connectGaps", connectGaps)}
          />
          {options.connectGaps === "threshold" ? (
            <DurationField
              label={t("panels.graph.connectGapsBelow")}
              hint={t("panels.graph.durationHint")}
              value={options.connectGapsBelow}
              onChange={(ms) => set("connectGapsBelow", ms)}
            />
          ) : null}
          <DurationField
            label={t("panels.graph.breakAfter")}
            hint={t("panels.graph.breakAfterHint")}
            value={options.breakAfter}
            onChange={(ms) => set("breakAfter", ms)}
          />
        </>
      )}
      <AutoSelect
        label={t("panels.graph.stack")}
        value={options.stack}
        autoLabel={t("panels.graph.stack.auto")}
        choices={STACKINGS.map((s) => [s, t(`panels.graph.stack.${s}`)])}
        onChange={(stack) => set("stack", stack)}
      />
      {stacked ? (
        <TextField
          label={t("panels.graph.stackGroup")}
          hint={t("panels.graph.stackGroupHint")}
          value={options.stackGroup ?? ""}
          maxLength={L.stackGroupChars}
          onChange={(group) => set("stackGroup", group)}
        />
      ) : null}
      <CheckboxField
        label={t("panels.graph.comparison")}
        checked={options.comparison === true}
        onChange={(comparison) => set("comparison", comparison ? true : undefined)}
      />
    </>
  );
}
