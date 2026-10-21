import { isRecord } from "../../api/client";
import type { FieldConfig } from "./fieldConfig";
import { CUSTOM_PREFIX, isCatalogUnit } from "./units";

/**
 * Panels saved before the field options existed kept a free-text unit in `options.unit`, the
 * time series its series name template in `options.legend` (now `seriesName`) and switches
 * `showLegend` and `sparkline`. They still draw as before; the panel editor moves them to their
 * new place when a panel is opened, so the next save stores the current form.
 */

/** A unit as the field options store it: a catalog id stays, free text becomes a suffix. */
export function unitId(text: string): string {
  return isCatalogUnit(text) || text.startsWith(CUSTOM_PREFIX) ? text : `${CUSTOM_PREFIX}${text}`;
}

/** The field options with an old options unit as the default unit, unless one is set. */
export function legacyUnit(config: FieldConfig, unit: string | undefined): FieldConfig {
  if (unit === undefined || unit === "" || config.defaults.unit !== undefined) {
    return config;
  }
  return { ...config, defaults: { ...config.defaults, unit: unitId(unit) } };
}

interface StoredPanel {
  options: unknown;
  fieldConfig: unknown;
}

/** The panel with old option keys moved to where they live now; unchanged when there are none. */
export function upgradePanel<P extends StoredPanel>(panel: P): P {
  if (!isRecord(panel.options)) {
    return panel;
  }
  const options: Record<string, unknown> = { ...panel.options };
  const fieldConfig: Record<string, unknown> = isRecord(panel.fieldConfig)
    ? { ...panel.fieldConfig }
    : {};
  let changed = false;
  if ("unit" in options) {
    const unit = options.unit;
    delete options.unit;
    const defaults = isRecord(fieldConfig.defaults) ? { ...fieldConfig.defaults } : {};
    if (typeof unit === "string" && unit !== "" && defaults.unit === undefined) {
      defaults.unit = unitId(unit);
    }
    fieldConfig.defaults = defaults;
    changed = true;
  }
  if (typeof options.legend === "string") {
    if (options.legend !== "" && options.seriesName === undefined) {
      options.seriesName = options.legend;
    }
    delete options.legend;
    changed = true;
  }
  if ("showLegend" in options) {
    if (options.showLegend === false && !isRecord(options.legend)) {
      options.legend = { mode: "hidden", placement: "bottom", values: [] };
    }
    delete options.showLegend;
    changed = true;
  }
  if ("sparkline" in options) {
    if (options.graphMode === undefined) {
      options.graphMode = options.sparkline === false ? "none" : "area";
    }
    delete options.sparkline;
    changed = true;
  }
  return changed ? { ...panel, options, fieldConfig } : panel;
}
