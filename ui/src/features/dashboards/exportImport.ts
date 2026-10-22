import { isRecord } from "../../api/client";
import type { LinkedPanel } from "./api";
import type { DashboardModel } from "./model";

/**
 * Dashboards as JSON files. An export carries the model and, for every data source it uses, the
 * source's kind and name, so another organization or server can map them to its own sources by
 * kind and name; the user confirms that mapping before the import is saved. Library panels are
 * written into the export as panels of their own, since their ids mean nothing elsewhere.
 */

export interface ExportedSource {
  id: string;
  kind?: string | undefined;
  name?: string | undefined;
}

export interface DashboardExport {
  kalzit: "dashboard";
  exportVersion: 1;
  model: DashboardModel;
  datasources: ExportedSource[];
}

/** Every data source id the model's queries use, in first-use order. */
export function referencedSources(model: DashboardModel): string[] {
  const ids = [
    ...model.panels.flatMap((p) => p.targets.map((t) => t.datasourceId)),
    ...model.variables.flatMap((v) => (v.datasourceId === undefined ? [] : [v.datasourceId])),
    ...(model.annotations ?? []).map((a) => a.datasourceId),
  ];
  return [...new Set(ids.filter((id) => id !== ""))];
}

/** The model with library panels written in as plain panels. */
export function inlineLibraryPanels(
  model: DashboardModel,
  library: Record<string, LinkedPanel>,
): DashboardModel {
  return {
    ...model,
    panels: model.panels.map((panel) => {
      const linked = panel.libraryPanelId === undefined ? undefined : library[panel.libraryPanelId];
      if (linked === undefined) {
        return panel;
      }
      const { libraryPanelId: _id, ...place } = panel;
      return {
        ...linked.model,
        ...place,
        id: panel.id,
        grid: panel.grid,
        targets: linked.model.targets,
      };
    }),
  };
}

export function buildExport(
  model: DashboardModel,
  library: Record<string, LinkedPanel>,
  sources: readonly { id: string; kind: string; name: string }[],
): DashboardExport {
  const inlined = inlineLibraryPanels(model, library);
  return {
    kalzit: "dashboard",
    exportVersion: 1,
    model: inlined,
    datasources: referencedSources(inlined).map((id) => {
      const known = sources.find((s) => s.id === id);
      return known === undefined ? { id } : { id, kind: known.kind, name: known.name };
    }),
  };
}

/** A file's text as model and sources: an export, or a bare model (sources then by id only). */
export function readImport(text: string): { model: unknown; sources: ExportedSource[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.kalzit === "dashboard" && isRecord(value.model)) {
    const sources = (Array.isArray(value.datasources) ? value.datasources : []).flatMap((s) =>
      isRecord(s) && typeof s.id === "string"
        ? [
            {
              id: s.id,
              kind: typeof s.kind === "string" ? s.kind : undefined,
              name: typeof s.name === "string" ? s.name : undefined,
            },
          ]
        : [],
    );
    return { model: value.model, sources };
  }
  return { model: value, sources: [] };
}

/**
 * The suggested target per exported source: the same id if it exists here (an export from this
 * organization), else the only source here with the same kind and name, else none.
 */
export function suggestMapping(
  sources: readonly ExportedSource[],
  available: readonly { id: string; kind: string; name: string }[],
): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const source of sources) {
    if (available.some((a) => a.id === source.id)) {
      mapping[source.id] = source.id;
      continue;
    }
    const matches = available.filter((a) => a.kind === source.kind && a.name === source.name);
    mapping[source.id] = matches.length === 1 ? (matches[0]?.id ?? "") : "";
  }
  return mapping;
}

/** The model with every data source id replaced through `mapping`. */
export function remapSources(
  model: DashboardModel,
  mapping: Record<string, string>,
): DashboardModel {
  const map = (id: string) => mapping[id] ?? id;
  return {
    ...model,
    panels: model.panels.map((p) => ({
      ...p,
      targets: p.targets.map((t) => ({ ...t, datasourceId: map(t.datasourceId) })),
    })),
    variables: model.variables.map((v) =>
      v.datasourceId === undefined ? v : { ...v, datasourceId: map(v.datasourceId) },
    ),
    ...(model.annotations === undefined
      ? {}
      : {
          annotations: model.annotations.map((a) => ({ ...a, datasourceId: map(a.datasourceId) })),
        }),
  };
}

/** Offers the export as a file download, named after the title. */
export function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "dashboard"}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
