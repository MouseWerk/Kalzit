import type { DashboardModel, PanelModel } from "./model";

/** One difference between two dashboard models, described for people, not for patching. */
export type Change =
  | { kind: "title"; from: string; to: string }
  | { kind: "timeRange" }
  | { kind: "refresh" }
  | { kind: "variables" }
  | { kind: "panelAdded"; title: string }
  | { kind: "panelRemoved"; title: string }
  | { kind: "panelChanged"; title: string }
  | { kind: "panelMoved"; title: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function withoutGrid(panel: PanelModel): Omit<PanelModel, "grid"> {
  const { grid: _grid, ...rest } = panel;
  return rest;
}

/** What changed from `before` to `after`: settings first, then panels in the order of `after`. */
export function diffModels(before: DashboardModel, after: DashboardModel): Change[] {
  const changes: Change[] = [];
  if (before.title !== after.title) {
    changes.push({ kind: "title", from: before.title, to: after.title });
  }
  if (!same(before.timeRange, after.timeRange)) {
    changes.push({ kind: "timeRange" });
  }
  if (before.refreshSeconds !== after.refreshSeconds) {
    changes.push({ kind: "refresh" });
  }
  if (!same(before.variables, after.variables)) {
    changes.push({ kind: "variables" });
  }
  const old = new Map(before.panels.map((p) => [p.id, p]));
  for (const panel of after.panels) {
    const previous = old.get(panel.id);
    if (previous === undefined) {
      changes.push({ kind: "panelAdded", title: panel.title });
    } else if (!same(withoutGrid(previous), withoutGrid(panel))) {
      changes.push({ kind: "panelChanged", title: panel.title });
    } else if (!same(previous.grid, panel.grid)) {
      changes.push({ kind: "panelMoved", title: panel.title });
    }
  }
  const kept = new Set(after.panels.map((p) => p.id));
  for (const panel of before.panels) {
    if (!kept.has(panel.id)) {
      changes.push({ kind: "panelRemoved", title: panel.title });
    }
  }
  return changes;
}
