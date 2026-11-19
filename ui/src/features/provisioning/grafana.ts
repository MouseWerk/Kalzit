import { isRecord } from "../../api/client";

/*
 * What the import reads from a Grafana dashboard file before it asks the server: the dashboard
 * inside a wrapping export, what it holds, and the data sources its panels name, by the keys the
 * server's mapping takes (docs/guide/grafana-import.md). The conversion itself is the server's.
 */

/** The largest file the import page reads. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface GrafanaSource {
  /** The key of the mapping: the uid, the name, `${DS_X}` or `default`. */
  key: string;
  /** How the file names it. */
  label: string;
  /** Grafana's plugin id (`prometheus`), when the file says. */
  type: string;
  /** Panels, variables and annotation queries that use it. */
  uses: number;
  /** A variable picks the source (`${datasource}`); it becomes a fixed source. */
  variable: boolean;
}

export interface GrafanaFile {
  /** What goes to the server: the file as read. */
  document: unknown;
  title: string;
  schemaVersion: number | null;
  panels: number;
  rows: number;
  variables: number;
  annotations: number;
  libraryPanels: number;
  sources: GrafanaSource[];
}

export type GrafanaProblem = "json" | "notDashboard";

const SPECIAL = new Set([
  "-- Mixed --",
  "-- Dashboard --",
  "-- Grafana --",
  "grafana",
  "__expr__",
  "-- Expression --",
]);
const SPECIAL_TYPES = new Set(["datasource", "grafana", "__expr__"]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Every panel of the file: the new layout's, those inside folded rows, and the old rows'. */
function panelsOf(dashboard: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const panel of list(dashboard.panels)) {
    if (panel.type === "row") {
      out.push(...list(panel.panels));
    } else {
      out.push(panel);
    }
  }
  for (const row of list(dashboard.rows)) {
    out.push(...list(row.panels));
  }
  return out;
}

/** The reference as the server keys it; null for Grafana's own pseudo sources. */
function sourceOf(
  raw: unknown,
  inputs: ReadonlyMap<string, string>,
): Omit<GrafanaSource, "uses"> | null {
  if (raw === undefined || raw === null) {
    return { key: "default", label: "", type: "", variable: false };
  }
  if (typeof raw === "string") {
    if (SPECIAL.has(raw)) return null;
    const inner = raw.replace(/^\$\{?/, "").replace(/\}$/, "");
    return {
      key: raw,
      label: raw.startsWith("$") ? (inputs.get(inner) ?? raw) : raw,
      type: "",
      variable: raw.startsWith("$") && !inputs.has(inner),
    };
  }
  if (!isRecord(raw)) {
    return null;
  }
  const uid = text(raw.uid);
  const type = text(raw.type);
  if (SPECIAL.has(uid) || SPECIAL_TYPES.has(type)) return null;
  if (uid === "") {
    return { key: "default", label: "", type, variable: false };
  }
  const inner = uid.replace(/^\$\{?/, "").replace(/\}$/, "");
  return {
    key: uid,
    label: uid.startsWith("$") ? (inputs.get(inner) ?? uid) : uid,
    type,
    variable: uid.startsWith("$") && !inputs.has(inner),
  };
}

/** Reads a Grafana dashboard file; a problem when it is not JSON or not a dashboard. */
export function readGrafana(source: string): GrafanaFile | GrafanaProblem {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    return "json";
  }
  if (!isRecord(document)) {
    return "notDashboard";
  }
  // An export from the API wraps the dashboard: { "dashboard": ..., "meta": ... }.
  const dashboard = isRecord(document.dashboard) ? document.dashboard : document;
  if (dashboard.panels === undefined && dashboard.rows === undefined) {
    return "notDashboard";
  }
  const inputs = new Map<string, string>();
  for (const input of list(document.__inputs ?? dashboard.__inputs)) {
    const name = text(input.name);
    const label = text(input.label) || text(input.pluginName);
    if (name !== "" && label !== "") inputs.set(name, label);
  }
  const panels = panelsOf(dashboard);
  const variables = list(isRecord(dashboard.templating) ? dashboard.templating.list : undefined);
  const annotations = list(
    isRecord(dashboard.annotations) ? dashboard.annotations.list : undefined,
  ).filter((annotation) => annotation.builtIn !== 1 && annotation.type !== "dashboard");

  const sources = new Map<string, GrafanaSource>();
  const use = (raw: unknown) => {
    const found = sourceOf(raw, inputs);
    if (found === null) return;
    const known = sources.get(found.key);
    if (known === undefined) {
      sources.set(found.key, { ...found, uses: 1 });
    } else {
      known.uses += 1;
      if (known.type === "") known.type = found.type;
    }
  };
  for (const panel of panels) {
    if (text(panel.type) === "text" || isRecord(panel.libraryPanel)) continue;
    const targets = list(panel.targets);
    const own = new Set<string>();
    for (const target of targets) {
      const raw = target.datasource ?? panel.datasource;
      const key = sourceOf(raw, inputs)?.key;
      // One use per panel and source, however many queries it has.
      if (key !== undefined && !own.has(key)) {
        own.add(key);
        use(raw);
      }
    }
    if (targets.length === 0 && panel.datasource !== undefined) {
      use(panel.datasource);
    }
  }
  for (const variable of variables) {
    if (text(variable.type) === "query") use(variable.datasource);
  }
  for (const annotation of annotations) {
    use(annotation.datasource);
  }
  const version = dashboard.schemaVersion;
  return {
    document,
    title: text(dashboard.title),
    schemaVersion: typeof version === "number" ? version : null,
    panels: panels.length,
    rows:
      list(dashboard.panels).filter((panel) => panel.type === "row").length +
      list(dashboard.rows).length,
    variables: variables.length,
    annotations: annotations.length,
    libraryPanels: panels.filter((panel) => isRecord(panel.libraryPanel)).length,
    sources: [...sources.values()],
  };
}

/** The file with another title, as the import form lets people name the dashboard. */
export function withTitle(document: unknown, title: string): unknown {
  if (!isRecord(document)) return document;
  if (isRecord(document.dashboard)) {
    return { ...document, dashboard: { ...document.dashboard, title } };
  }
  return { ...document, title };
}

/** Kalzit's data source kind for a Grafana plugin id. */
const KIND_OF: Record<string, string> = {
  prometheus: "prometheus",
  loki: "loki",
  postgres: "postgres",
  "grafana-postgresql-datasource": "postgres",
  mysql: "mysql",
  mssql: "mssql",
  "frser-sqlite-datasource": "sqlite",
  "grafana-clickhouse-datasource": "clickhouse",
  "vertamedia-clickhouse-datasource": "clickhouse",
  elasticsearch: "elasticsearch",
  "grafana-opensearch-datasource": "opensearch",
  influxdb: "influxdb",
};

export type Suggestion = "sameName" | "sameKind" | "none";

/**
 * The Kalzit source proposed for one of the file: the one of the same name, else the only one of
 * its kind. Nothing is proposed when several of the kind exist; people pick then.
 */
export function suggestSource(
  source: GrafanaSource,
  available: readonly { id: string; kind: string; name: string }[],
): { id: string; why: Suggestion } {
  const fold = (value: string) => value.trim().toLowerCase();
  const kind = KIND_OF[source.type];
  const named = available.filter(
    (candidate) =>
      source.label !== "" &&
      fold(candidate.name) === fold(source.label) &&
      (kind === undefined || candidate.kind === kind),
  );
  if (named.length === 1 && named[0] !== undefined) {
    return { id: named[0].id, why: "sameName" };
  }
  const ofKind = kind === undefined ? [] : available.filter((c) => c.kind === kind);
  if (ofKind.length === 1 && ofKind[0] !== undefined) {
    return { id: ofKind[0].id, why: "sameKind" };
  }
  return { id: "", why: "none" };
}
