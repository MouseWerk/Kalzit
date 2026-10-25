import type { IconName } from "../../components/Icon";

/** The icon of each visualization, for the outline, the inspector and the Add pane. */
const ICONS: Readonly<Record<string, IconName>> = {
  timeseries: "activity",
  bar: "barChart",
  histogram: "barChart",
  stat: "stat",
  table: "table",
  gauge: "gauge",
  bargauge: "gauge",
  piechart: "pie",
  heatmap: "table",
  "state-timeline": "rows",
  "status-history": "rows",
  text: "text",
  network: "network",
  hierarchy: "network",
  path: "network",
  documents: "code",
  document: "code",
  schema: "code",
  distribution: "barChart",
};

export function panelIcon(type: string): IconName {
  return Object.hasOwn(ICONS, type) ? (ICONS[type] as IconName) : "stat";
}

/** The visualizations the inspector offers to switch between, as on the blueprint. */
export const SWITCH_TYPES = [
  "timeseries",
  "bar",
  "stat",
  "table",
  "piechart",
  "network",
  "text",
  "gauge",
] as const;
