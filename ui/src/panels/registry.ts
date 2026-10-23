import type { QueryResult, Shape } from "../api/generated/shapes";
import { barPanel } from "./bar";
import { barGaugePanel } from "./bargauge";
import { distributionPanel } from "./distribution";
import { documentCardPanel } from "./document";
import { documentsPanel } from "./documents";
import { timeField, valueFields } from "./frame";
import { gaugePanel } from "./gauge";
import { heatmapPanel } from "./heatmap";
import { hierarchyPanel } from "./hierarchy";
import { histogramPanel } from "./histogram";
import { networkPanel } from "./network";
import { pathPanel } from "./path";
import { pieChartPanel } from "./piechart";
import { schemaPanel } from "./schema";
import { statPanel } from "./stat";
import { stateTimelinePanel, statusHistoryPanel } from "./state";
import { tablePanel } from "./table";
import { textPanel } from "./text";
import { timeseriesPanel } from "./timeseries";
import type { AnyPanelPlugin } from "./types";

/**
 * Every panel type, in the order the picker offers them when several accept a shape. Graph
 * panels (M3) are added here with the shapes they accept.
 */
export const PANELS: readonly AnyPanelPlugin[] = [
  timeseriesPanel,
  statPanel,
  gaugePanel,
  barGaugePanel,
  barPanel,
  tablePanel,
  pieChartPanel,
  histogramPanel,
  heatmapPanel,
  stateTimelinePanel,
  statusHistoryPanel,
  documentsPanel,
  schemaPanel,
  distributionPanel,
  documentCardPanel,
  networkPanel,
  hierarchyPanel,
  pathPanel,
  textPanel,
];

export function getPanel(type: string): AnyPanelPlugin | undefined {
  return PANELS.find((panel) => panel.type === type);
}

/**
 * Panels that accept any of the shapes first, then the rest, each group in registry order. A
 * panel that draws without a query (text) fits every result.
 */
export function panelsForShapes(
  shapes: readonly Shape[],
): { panel: AnyPanelPlugin; accepts: boolean }[] {
  const entries = PANELS.map((panel) => ({
    panel,
    accepts: panel.standalone === true || panel.shapes.some((shape) => shapes.includes(shape)),
  }));
  return [...entries.filter((e) => e.accepts), ...entries.filter((e) => !e.accepts)];
}

/**
 * The panel that fits a set of results best: for graphs the network (the path panel when every
 * graph is made of paths), for frames a time series when there is time, else a table; documents
 * open in the document explorer.
 */
export function suggestPanel(results: readonly QueryResult[]): string {
  const graphs = results.flatMap((r) => (r.shape === "graph" ? [r.graph] : []));
  if (graphs.length > 0 && graphs.length === results.length) {
    return graphs.every((g) => (g.paths?.length ?? 0) > 0) ? pathPanel.type : networkPanel.type;
  }
  const frames = results.flatMap((r) => (r.shape === "frame" ? [r.frame] : []));
  if (frames.some((f) => timeField(f) !== undefined && valueFields(f).length > 0)) {
    return timeseriesPanel.type;
  }
  if (frames.length === 0 && results.some((r) => r.shape === "documents")) {
    return documentsPanel.type;
  }
  return tablePanel.type;
}
