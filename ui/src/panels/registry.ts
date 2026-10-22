import type { QueryResult, Shape } from "../api/generated/shapes";
import { barPanel } from "./bar";
import { timeField, valueFields } from "./frame";
import { statPanel } from "./stat";
import { tablePanel } from "./table";
import { timeseriesPanel } from "./timeseries";
import type { AnyPanelPlugin } from "./types";

/**
 * Every panel type, in the order the picker offers them when several accept a shape. Document
 * and graph panels (M2, M3) are added here with the shapes they accept.
 */
export const PANELS: readonly AnyPanelPlugin[] = [timeseriesPanel, statPanel, barPanel, tablePanel];

export function getPanel(type: string): AnyPanelPlugin | undefined {
  return PANELS.find((panel) => panel.type === type);
}

/** Panels that accept any of the shapes first, then the rest, each group in registry order. */
export function panelsForShapes(
  shapes: readonly Shape[],
): { panel: AnyPanelPlugin; accepts: boolean }[] {
  const entries = PANELS.map((panel) => ({
    panel,
    accepts: panel.shapes.some((shape) => shapes.includes(shape)),
  }));
  return [...entries.filter((e) => e.accepts), ...entries.filter((e) => !e.accepts)];
}

/** The panel that fits a set of results best: a time series when there is time, else a table. */
export function suggestPanel(results: readonly QueryResult[]): string {
  const frames = results.flatMap((r) => (r.shape === "frame" ? [r.frame] : []));
  if (frames.some((f) => timeField(f) !== undefined && valueFields(f).length > 0)) {
    return timeseriesPanel.type;
  }
  return tablePanel.type;
}
