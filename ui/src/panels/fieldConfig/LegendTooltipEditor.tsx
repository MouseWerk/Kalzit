import { useId } from "react";
import { useI18n } from "../../i18n/i18n";
import { CheckboxField, SelectField } from "../shared";
import {
  LEGEND_MODES,
  LEGEND_PLACEMENTS,
  LEGEND_VALUES,
  type LegendOptions,
  TOOLTIP_MODES,
  type TooltipOptions,
} from "./legendOptions";
import "../viz.css";

/** Legend and tooltip settings, shared by every panel that draws series. */
export function LegendTooltipEditor({
  legend,
  tooltip,
  onChange,
  withValues = true,
  hideLegend = false,
}: {
  legend: LegendOptions;
  tooltip?: TooltipOptions;
  onChange: (legend: LegendOptions, tooltip: TooltipOptions) => void;
  /** Whether the legend can show per-series values (last, min, max, mean). */
  withValues?: boolean;
  /** Only the tooltip: for panels without a legend. */
  hideLegend?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const tip = tooltip ?? { mode: "all" };
  if (hideLegend) {
    return tooltip === undefined ? null : (
      <SelectField
        id={`${id}-tooltip`}
        label={t("panels.tooltip.mode")}
        value={tooltip.mode}
        choices={TOOLTIP_MODES.map((m) => [m, t(`panels.tooltip.mode.${m}`)])}
        onChange={(mode) => onChange(legend, { mode })}
      />
    );
  }
  return (
    <>
      <SelectField
        id={`${id}-legend`}
        label={t("panels.legend.mode")}
        value={legend.mode}
        choices={LEGEND_MODES.map((m) => [m, t(`panels.legend.mode.${m}`)])}
        onChange={(mode) => onChange({ ...legend, mode }, tip)}
      />
      {legend.mode === "hidden" ? null : (
        <SelectField
          id={`${id}-placement`}
          label={t("panels.legend.placement")}
          value={legend.placement}
          choices={LEGEND_PLACEMENTS.map((p) => [p, t(`panels.legend.placement.${p}`)])}
          onChange={(placement) => onChange({ ...legend, placement }, tip)}
        />
      )}
      {legend.mode === "hidden" || !withValues ? null : (
        <fieldset className="viz-editor__group">
          <legend className="field__label">{t("panels.legend.values")}</legend>
          {LEGEND_VALUES.map((value) => (
            <CheckboxField
              key={value}
              label={t(`panels.legend.value.${value}`)}
              checked={legend.values.includes(value)}
              onChange={(checked) =>
                onChange(
                  {
                    ...legend,
                    values: LEGEND_VALUES.filter((v) =>
                      v === value ? checked : legend.values.includes(v),
                    ),
                  },
                  tip,
                )
              }
            />
          ))}
        </fieldset>
      )}
      {tooltip === undefined ? null : (
        <SelectField
          id={`${id}-tooltip`}
          label={t("panels.tooltip.mode")}
          value={tooltip.mode}
          choices={TOOLTIP_MODES.map((m) => [m, t(`panels.tooltip.mode.${m}`)])}
          onChange={(mode) => onChange(legend, { mode })}
        />
      )}
    </>
  );
}
