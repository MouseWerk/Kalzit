import type { DashboardModel, PanelModel } from "./model";

/** The parts of a panel a change touched, in the order the save dialog names them. */
export const PANEL_PARTS = [
  "title",
  "type",
  "queries",
  "queryOptions",
  "steps",
  "options",
  "fields",
  "links",
  "other",
] as const;
export type PanelPart = (typeof PANEL_PARTS)[number];

/** Settings of the dashboard that have no change of their own above. */
export type SettingsPart = "tags" | "rows" | "annotations" | "links";

/** One difference between two dashboard models, described for people, not for patching. */
export type Change =
  | { kind: "title"; from: string; to: string }
  | { kind: "timeRange" }
  | { kind: "refresh" }
  | { kind: "timeOptions" }
  | { kind: "variables"; names?: string[] }
  | { kind: "settings"; part: SettingsPart }
  | { kind: "panelAdded"; title: string }
  | { kind: "panelRemoved"; title: string }
  | { kind: "panelChanged"; title: string; parts?: PanelPart[] }
  | { kind: "panelMoved"; title: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function withoutGrid(panel: PanelModel): Omit<PanelModel, "grid"> {
  const { grid: _grid, ...rest } = panel;
  return rest;
}

/** Which part of a panel each of its fields belongs to; the place fields are no change here. */
const PART_OF: Readonly<Record<string, PanelPart | null>> = {
  id: null,
  grid: null,
  rowId: null,
  title: "title",
  type: "type",
  targets: "queries",
  libraryPanelId: "queries",
  analysisId: "queries",
  maxDataPoints: "queryOptions",
  minInterval: "queryOptions",
  cacheTimeout: "queryOptions",
  hideTimeNote: "queryOptions",
  timeFrom: "queryOptions",
  timeShift: "queryOptions",
  transformations: "steps",
  options: "options",
  fieldConfig: "fields",
  links: "links",
};

/** The parts in which two versions of a panel differ, in `PANEL_PARTS` order. */
export function panelParts(before: PanelModel, after: PanelModel): PanelPart[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const touched = new Set<PanelPart>();
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const key of keys) {
    const part = key in PART_OF ? PART_OF[key] : "other";
    if (part !== null && part !== undefined && !same(b[key], a[key])) {
      touched.add(part);
    }
  }
  return PANEL_PARTS.filter((part) => touched.has(part));
}

/** The variables whose definition differs, added and removed ones included, by name. */
function changedVariables(before: DashboardModel, after: DashboardModel): string[] {
  const old = new Map(before.variables.map((v) => [v.name, v]));
  const names: string[] = [];
  for (const variable of after.variables) {
    if (!same(old.get(variable.name), variable)) names.push(variable.name);
  }
  const kept = new Set(after.variables.map((v) => v.name));
  for (const variable of before.variables) {
    if (!kept.has(variable.name)) names.push(variable.name);
  }
  return names;
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
  if (
    before.refreshSeconds !== after.refreshSeconds ||
    !same(before.refreshIntervals, after.refreshIntervals)
  ) {
    changes.push({ kind: "refresh" });
  }
  const timeOptions = (m: DashboardModel) => [
    m.timeZone,
    m.weekStart,
    m.fiscalYearStartMonth,
    m.nowDelay,
    m.sharedCursor,
  ];
  if (!same(timeOptions(before), timeOptions(after))) {
    changes.push({ kind: "timeOptions" });
  }
  if (!same(before.variables, after.variables)) {
    const names = changedVariables(before, after);
    // Only the order changed: no variable to name.
    changes.push(names.length === 0 ? { kind: "variables" } : { kind: "variables", names });
  }
  for (const part of ["tags", "rows", "annotations", "links"] as const) {
    if (!same(before[part] ?? [], after[part] ?? [])) {
      changes.push({ kind: "settings", part });
    }
  }
  const old = new Map(before.panels.map((p) => [p.id, p]));
  for (const panel of after.panels) {
    const previous = old.get(panel.id);
    if (previous === undefined) {
      changes.push({ kind: "panelAdded", title: panel.title });
    } else if (!same(withoutGrid(previous), withoutGrid(panel))) {
      const parts = panelParts(previous, panel);
      changes.push(
        parts.length === 0
          ? { kind: "panelChanged", title: panel.title }
          : { kind: "panelChanged", title: panel.title, parts },
      );
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

/**
 * One line of a line-by-line comparison: kept, added (`+`) or removed (`-`); a `gap` stands for
 * unchanged lines left out.
 */
export interface DiffLine {
  kind: "same" | "added" | "removed" | "gap";
  text: string;
}

/** Above this many lines on both sides, the middle is shown as removed and added as a whole. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * The lines from `before` to `after`, as the longest common subsequence keeps them: common
 * lines at both ends are cut first, so a small change in a long model stays cheap.
 */
export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const head = before.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = before.slice(endB).map((text): DiffLine => ({ kind: "same", text }));
  const b = before.slice(start, endB);
  const a = after.slice(start, endA);
  const removed = (text: string): DiffLine => ({ kind: "removed", text });
  const added = (text: string): DiffLine => ({ kind: "added", text });
  if (b.length * a.length > MAX_DIFF_CELLS) {
    return [...head, ...b.map(removed), ...a.map(added), ...tail];
  }
  // lengths[i][j]: the longest common subsequence of b[i..] and a[j..].
  const width = a.length + 1;
  const lengths = new Uint32Array((b.length + 1) * width);
  for (let i = b.length - 1; i >= 0; i--) {
    for (let j = a.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        b[i] === a[j]
          ? (lengths[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lengths[(i + 1) * width + j] as number, lengths[i * width + j + 1] as number);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length && j < a.length) {
    if (b[i] === a[j]) {
      middle.push({ kind: "same", text: b[i] as string });
      i++;
      j++;
    } else if ((lengths[(i + 1) * width + j] as number) >= (lengths[i * width + j + 1] as number)) {
      middle.push(removed(b[i++] as string));
    } else {
      middle.push(added(a[j++] as string));
    }
  }
  while (i < b.length) middle.push(removed(b[i++] as string));
  while (j < a.length) middle.push(added(a[j++] as string));
  return [...head, ...middle, ...tail];
}

/** One changed part of the model as JSON lines, named by its place (`panels[2]`, `variables`). */
export interface JsonSection {
  path: string;
  lines: DiffLine[];
}

const lines = (value: unknown): string[] =>
  value === undefined ? [] : (JSON.stringify(value, null, 2) ?? "").split("\n");

/**
 * The model's changes as JSON, one section per changed setting and per changed panel (by its
 * place in `after`, or in `before` when removed). Only changed lines and up to `context` lines
 * around them are kept; a run of more unchanged lines is left out.
 */
export function jsonSections(
  before: DashboardModel,
  after: DashboardModel,
  context = 2,
): JsonSection[] {
  const sections: JsonSection[] = [];
  const add = (path: string, from: unknown, to: unknown) => {
    if (same(from, to)) return;
    sections.push({ path, lines: trimContext(lineDiff(lines(from), lines(to)), context) });
  };
  const { panels: beforePanels, ...beforeRest } = before;
  const { panels: afterPanels, ...afterRest } = after;
  const keys = new Set([...Object.keys(beforeRest), ...Object.keys(afterRest)]);
  const b = beforeRest as Record<string, unknown>;
  const a = afterRest as Record<string, unknown>;
  for (const key of keys) {
    add(key, b[key], a[key]);
  }
  const old = new Map(beforePanels.map((p, index) => [p.id, { p, index }]));
  afterPanels.forEach((panel, index) => {
    add(`panels[${index}]`, old.get(panel.id)?.p, panel);
  });
  const kept = new Set(afterPanels.map((p) => p.id));
  beforePanels.forEach((panel, index) => {
    if (!kept.has(panel.id)) add(`panels[${index}]`, panel, undefined);
  });
  return sections;
}

/**
 * The changed lines with `context` unchanged ones around each; every longer run of unchanged
 * lines left out becomes one `gap` line, at the ends too.
 */
function trimContext(diff: DiffLine[], context: number): DiffLine[] {
  const keep = new Uint8Array(diff.length);
  diff.forEach((line, index) => {
    if (line.kind === "same") return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(diff.length - 1, index + context);
      k++
    ) {
      keep[k] = 1;
    }
  });
  const out: DiffLine[] = [];
  diff.forEach((line, index) => {
    if (keep[index] === 1) {
      out.push(line);
    } else if (out[out.length - 1]?.kind !== "gap") {
      out.push({ kind: "gap", text: "" });
    }
  });
  return out;
}
