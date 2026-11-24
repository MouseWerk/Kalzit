import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { CheckboxField, NumberField, SelectField } from "../shared";
import { Section } from "./FieldConfigEditor";
import { LegendValuesField } from "./LegendValuesField";
import {
  LEGEND_LIMITS,
  LEGEND_PLACEMENTS,
  type LegendOptions,
  TOOLTIP_LIMITS,
  TOOLTIP_MODES,
  TOOLTIP_SORTS,
  type TooltipOptions,
  type TooltipSort,
} from "./legendOptions";
import "../viz.css";

/** The legend's kinds besides "hidden", which the switch "Legende zeigen" stands for. */
const LEGEND_KINDS = ["list", "table"] as const;

/**
 * The groups "Tooltip" and "Legende" (ParityEditors board, frames 3 and 4), shared by every panel
 * that draws series: the tooltip's mode and, where the panel supports them, its sort, hiding of
 * zeros and largest size; whether and how the legend shows, its position, width and limit, and
 * its values picked from the shared calculations (`calcs.ts`).
 */
export function LegendTooltipEditor({
  legend,
  tooltip,
  onChange,
  withValues = true,
  hideLegend = false,
  tooltipDetails = false,
}: {
  legend: LegendOptions;
  tooltip?: TooltipOptions;
  onChange: (legend: LegendOptions, tooltip: TooltipOptions) => void;
  /** Whether the legend can show per-series values (last, sum, percentiles, ...). */
  withValues?: boolean;
  /** Only the tooltip: for panels without a legend. */
  hideLegend?: boolean;
  /** The tooltip sorts, hides zeros and has a largest size (the time series). */
  tooltipDetails?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  // Hiding and showing the legend again keeps its kind (list or table).
  const [kind, setKind] = useState<"list" | "table">(legend.mode === "table" ? "table" : "list");
  const tip: TooltipOptions = tooltip ?? { mode: "all" };
  const setTip = (next: TooltipOptions) => onChange(legend, next);
  const setLegend = (next: LegendOptions) => onChange(next, tip);
  /** A copy without one optional key, for "Auto" and empty fields. */
  const without = <T extends object, K extends keyof T>(value: T, key: K): T => {
    const next = { ...value };
    delete next[key];
    return next;
  };

  const tooltipGroup =
    tooltip === undefined ? null : (
      <Section title={t("panels.section.tooltip")}>
        <SelectField
          id={`${id}-tooltip`}
          label={t("panels.tooltip.mode")}
          value={tip.mode}
          choices={TOOLTIP_MODES.map((m) => [m, t(`panels.tooltip.mode.${m}`)])}
          onChange={(mode) => setTip({ ...tip, mode })}
        />
        {!tooltipDetails || tip.mode === "hidden" ? null : (
          <>
            <SelectField<TooltipSort>
              label={t("panels.tooltip.sort")}
              hint={t("panels.tooltip.sortHint")}
              value={tip.sort ?? "none"}
              choices={TOOLTIP_SORTS.map((s) => [s, t(`panels.tooltip.sort.${s}`)] as const)}
              onChange={(sort) => setTip(sort === "none" ? without(tip, "sort") : { ...tip, sort })}
            />
            <CheckboxField
              label={t("panels.tooltip.hideZeros")}
              checked={tip.hideZeros === true}
              onChange={(hideZeros) =>
                setTip(hideZeros ? { ...tip, hideZeros } : without(tip, "hideZeros"))
              }
            />
            <NumberField
              label={t("panels.tooltip.maxWidth")}
              placeholder={t("panels.graph.auto")}
              value={tip.maxWidth}
              min={TOOLTIP_LIMITS.minSize}
              max={TOOLTIP_LIMITS.maxSize}
              step={1}
              onChange={(maxWidth) =>
                maxWidth === undefined
                  ? setTip(without(tip, "maxWidth"))
                  : Number.isInteger(maxWidth)
                    ? setTip({ ...tip, maxWidth })
                    : undefined
              }
            />
            <NumberField
              label={t("panels.tooltip.maxHeight")}
              hint={t("panels.tooltip.maxHeightHint")}
              placeholder={t("panels.graph.auto")}
              value={tip.maxHeight}
              min={TOOLTIP_LIMITS.minSize}
              max={TOOLTIP_LIMITS.maxSize}
              step={1}
              onChange={(maxHeight) =>
                maxHeight === undefined
                  ? setTip(without(tip, "maxHeight"))
                  : Number.isInteger(maxHeight)
                    ? setTip({ ...tip, maxHeight })
                    : undefined
              }
            />
          </>
        )}
      </Section>
    );
  if (hideLegend) {
    return tooltipGroup;
  }
  const shown = legend.mode !== "hidden";
  return (
    <>
      {tooltipGroup}
      <Section title={t("panels.section.legend")}>
        <CheckboxField
          label={t("panels.legend.show")}
          checked={shown}
          onChange={(show) => setLegend({ ...legend, mode: show ? kind : "hidden" })}
        />
        {!shown ? null : (
          <>
            <SelectField
              id={`${id}-legend`}
              label={t("panels.legend.kind")}
              value={legend.mode === "table" ? "table" : "list"}
              choices={LEGEND_KINDS.map((m) => [m, t(`panels.legend.mode.${m}`)] as const)}
              onChange={(mode) => {
                setKind(mode);
                setLegend({ ...legend, mode });
              }}
            />
            <SelectField
              id={`${id}-placement`}
              label={t("panels.legend.placement")}
              value={legend.placement}
              choices={LEGEND_PLACEMENTS.map((p) => [p, t(`panels.legend.placement.${p}`)])}
              onChange={(placement) => setLegend({ ...legend, placement })}
            />
            {legend.placement !== "right" ? null : (
              <NumberField
                label={t("panels.legend.width")}
                hint={t("panels.legend.widthHint")}
                placeholder={t("panels.graph.auto")}
                value={legend.width}
                min={LEGEND_LIMITS.minWidth}
                max={LEGEND_LIMITS.maxWidth}
                step={1}
                onChange={(width) =>
                  width === undefined
                    ? setLegend(without(legend, "width"))
                    : Number.isInteger(width)
                      ? setLegend({ ...legend, width })
                      : undefined
                }
              />
            )}
            <NumberField
              label={t("panels.legend.limit")}
              hint={t("panels.legend.limitHint")}
              value={legend.limit}
              min={LEGEND_LIMITS.minLimit}
              max={LEGEND_LIMITS.maxLimit}
              step={1}
              onChange={(limit) =>
                limit === undefined
                  ? setLegend(without(legend, "limit"))
                  : Number.isInteger(limit)
                    ? setLegend({ ...legend, limit })
                    : undefined
              }
            />
            {!withValues ? null : (
              <LegendValuesField
                values={legend.values}
                onChange={(values) => setLegend({ ...legend, values })}
              />
            )}
          </>
        )}
      </Section>
    </>
  );
}
