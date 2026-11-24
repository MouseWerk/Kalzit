import type { DashboardModel, VariableModel } from "./model";
import { mentionedNames } from "./model";

/**
 * Which variables a dashboard's parts use (board ParityEditors, frame 11), worked out in the
 * browser from the names each part mentions (`$name`, `${name}`, `${name:format}`): a query
 * variable's query, panels (queries, sources, repeat, title, options and links), rows, annotation
 * queries and dashboard links. Names starting with `__` are Kalzit's own macros, not variables.
 */

/** A place that uses a variable. */
export interface VariableUse {
  kind: "variable" | "panel" | "row" | "annotation" | "link";
  /** Variable name, panel or row title, annotation name, link title. */
  name: string;
  /** Stable within the model: variable name, panel, row or annotation id, link index. */
  id: string;
}

export interface VariableDependency {
  variable: VariableModel;
  /** The variables this one's query uses, in the dashboard's order. */
  dependsOn: string[];
  /** Everything that uses this variable. */
  usedBy: VariableUse[];
}

export interface DependencyReport {
  variables: VariableDependency[];
  /** Names that are used but no variable has, with who uses them. */
  unknown: { name: string; usedBy: VariableUse[] }[];
  /** Cycles of variables that need each other, each as the names in order. */
  cycles: string[][];
  /** Load order: each variable's column (0 = needs no other variable). */
  levels: Record<string, number>;
  /** How many panels use at least one variable. */
  panelsUsing: number;
}

function names(value: unknown): string[] {
  return [...mentionedNames(value)].filter((n) => n !== "" && !n.startsWith("__"));
}

/** The variables a variable's own definition uses: a query variable's query. */
export function variableInputs(variable: VariableModel): string[] {
  if (variable.type !== "query") return [];
  return names(variable.query).filter((n) => n !== variable.name);
}

export function dependencies(model: DashboardModel): DependencyReport {
  const defined = new Map(model.variables.map((v) => [v.name, v]));
  const uses = new Map<string, VariableUse[]>();
  const note = (name: string, use: VariableUse) => {
    const list = uses.get(name) ?? [];
    if (!list.some((u) => u.kind === use.kind && u.id === use.id)) list.push(use);
    uses.set(name, list);
  };

  for (const variable of model.variables) {
    for (const name of variableInputs(variable)) {
      note(name, { kind: "variable", name: variable.name, id: variable.name });
    }
  }
  let panelsUsing = 0;
  for (const panel of model.panels) {
    // Position and size never name a variable; everything else of the panel may.
    const { grid: _grid, ...rest } = panel;
    const found = new Set(names(rest));
    if (panel.repeat !== undefined) found.add(panel.repeat.variable);
    if (found.size > 0) panelsUsing += 1;
    for (const name of found) {
      note(name, { kind: "panel", name: panel.title, id: panel.id });
    }
  }
  for (const row of model.rows ?? []) {
    const found = new Set(names(row.title));
    if (row.repeat !== undefined) found.add(row.repeat.variable);
    for (const name of found) note(name, { kind: "row", name: row.title, id: row.id });
  }
  for (const annotation of model.annotations ?? []) {
    for (const name of names(annotation.query)) {
      note(name, { kind: "annotation", name: annotation.name, id: annotation.id });
    }
  }
  (model.links ?? []).forEach((link, index) => {
    const text = link.type === "url" ? [link.title, link.url] : [link.title];
    for (const name of names(text)) {
      note(name, { kind: "link", name: link.title, id: String(index) });
    }
  });

  const variables = model.variables.map((variable) => ({
    variable,
    dependsOn: variableInputs(variable).filter((n) => defined.has(n)),
    usedBy: uses.get(variable.name) ?? [],
  }));
  const unknown = [...uses.entries()]
    .filter(([name]) => !defined.has(name))
    .map(([name, usedBy]) => ({ name, usedBy }));
  const graph = new Map(variables.map((d) => [d.variable.name, d.dependsOn]));
  return {
    variables,
    unknown,
    cycles: findCycles(graph),
    levels: levelsOf(graph),
    panelsUsing,
  };
}

/** Each cycle once, starting at its first variable in the dashboard's order. */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const order = [...graph.keys()];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (name: string) => {
    state.set(name, "open");
    path.push(name);
    for (const next of graph.get(name) ?? []) {
      if (state.get(next) === "open") {
        const cycle = path.slice(path.indexOf(next));
        const start = cycle.reduce((best, n) =>
          order.indexOf(n) < order.indexOf(best) ? n : best,
        );
        const at = cycle.indexOf(start);
        const rotated = [...cycle.slice(at), ...cycle.slice(0, at)];
        const key = rotated.join("\u0000");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(rotated);
        }
      } else if (state.get(next) === undefined && graph.has(next)) {
        visit(next);
      }
    }
    path.pop();
    state.set(name, "done");
  };
  for (const name of order) {
    if (state.get(name) === undefined) visit(name);
  }
  return cycles;
}

/**
 * The column of each variable: one more than the furthest variable it needs. Variables in a
 * cycle count edges inside it as absent, so the drawing still ends.
 */
export function levelsOf(graph: ReadonlyMap<string, readonly string[]>): Record<string, number> {
  const levels: Record<string, number> = {};
  const stack = new Set<string>();
  const level = (name: string): number => {
    const known = levels[name];
    if (known !== undefined) return known;
    if (stack.has(name)) return -1;
    stack.add(name);
    let deepest = -1;
    for (const next of graph.get(name) ?? []) {
      if (graph.has(next)) deepest = Math.max(deepest, level(next));
    }
    stack.delete(name);
    levels[name] = deepest + 1;
    return deepest + 1;
  };
  for (const name of graph.keys()) level(name);
  return levels;
}
