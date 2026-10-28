import { useSyncExternalStore } from "react";
import type { QueryResult, Shape } from "../api/generated/shapes";
import type { Translate } from "../i18n/i18n";
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

/**
 * The panel types of installed panel plugins (`features/plugins/panel`), after the built-in ones.
 * Set when an organization's list arrives; components that look panels up subscribe with
 * `useExternalPanels`, so a dashboard drawn before the list arrived draws them once it is there.
 */
let external: readonly AnyPanelPlugin[] = [];
const listeners = new Set<() => void>();

export function setExternalPanels(panels: readonly AnyPanelPlugin[]): void {
  if (panels === external) {
    return;
  }
  external = panels.filter((p) => !PANELS.some((built) => built.type === p.type));
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function externalPanels(): readonly AnyPanelPlugin[] {
  return external;
}

/** The panel types of plugins; renders again when they change. */
export function useExternalPanels(): readonly AnyPanelPlugin[] {
  return useSyncExternalStore(subscribe, externalPanels, externalPanels);
}

/**
 * The panel type `type`: a built-in one, else one of `plugins` (the plugins' panel types known
 * now). A component passes what `useExternalPanels` gave it, so its drawing depends on the list
 * and is redone when the list changes.
 */
export function getPanel(
  type: string,
  plugins: readonly AnyPanelPlugin[] = external,
): AnyPanelPlugin | undefined {
  return PANELS.find((panel) => panel.type === type) ?? plugins.find((p) => p.type === type);
}

/** The name of a panel type as the picker shows it: a plugin's own, else the catalog's. */
export function panelName(t: Translate, panel: AnyPanelPlugin): string {
  return panel.label ?? t(panel.name);
}

/** The one-line description of a panel type, if it has one. */
export function panelDescription(t: Translate, panel: AnyPanelPlugin): string | undefined {
  return panel.hint ?? (panel.description === undefined ? undefined : t(panel.description));
}

/**
 * Panels that accept any of the shapes first, then the rest, each group in registry order and
 * the plugins' panels (`plugins`, from `useExternalPanels`) after the built-in ones. A panel that
 * draws without a query (text) fits every result. Explore passes none: it has no dashboard to
 * show them on.
 */
export function panelsForShapes(
  shapes: readonly Shape[],
  plugins: readonly AnyPanelPlugin[] = [],
): { panel: AnyPanelPlugin; accepts: boolean }[] {
  const entries = [...PANELS, ...plugins].map((panel) => ({
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
