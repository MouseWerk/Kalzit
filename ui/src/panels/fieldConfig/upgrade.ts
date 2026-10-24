import { isRecord } from "../../api/client";
import type { FieldConfig } from "./fieldConfig";
import { CUSTOM_PREFIX } from "./units";

/**
 * Panels saved before the field options existed kept a free-text unit in `options.unit`, the
 * time series its series name template in `options.legend` (now `seriesName`) and its line
 * width in `options.lineWidth` (now a field option), and switches `showLegend` and `sparkline`. They still draw as before; the panel editor moves them to their
 * new place when a panel is opened, so the next save stores the current form.
 */

/**
 * A unit typed before the catalog existed. It was a plain suffix after the number, so it stays
 * one: "ms" keeps meaning "write ms after the value", not "scale to s and min".
 */
export function unitId(text: string): string {
  return text.startsWith(CUSTOM_PREFIX) ? text : `${CUSTOM_PREFIX}${text}`;
}

/** The field options with an old options unit as the default unit, unless one is set. */
export function legacyUnit(config: FieldConfig, unit: string | undefined): FieldConfig {
  if (unit === undefined || unit === "" || config.defaults.unit !== undefined) {
    return config;
  }
  return { ...config, defaults: { ...config.defaults, unit: unitId(unit) } };
}

/**
 * The time series' line width from before the graph style (`options.lineWidth`, 1 to 3) as the
 * default line width, unless one is set. 1 was the editor's default and is left to the
 * automatic width.
 */
export function legacyLineWidth(config: FieldConfig, lineWidth: number | undefined): FieldConfig {
  if (lineWidth === undefined || lineWidth === 1 || config.defaults.lineWidth !== undefined) {
    return config;
  }
  return { ...config, defaults: { ...config.defaults, lineWidth } };
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
  if ("lineWidth" in options) {
    const width = options.lineWidth;
    delete options.lineWidth;
    const defaults = isRecord(fieldConfig.defaults) ? { ...fieldConfig.defaults } : {};
    if (typeof width === "number" && width !== 1 && defaults.lineWidth === undefined) {
      defaults.lineWidth = width;
    }
    fieldConfig.defaults = defaults;
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
