import type { PanelQueryRequest, QueryOutcome } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import { answerQuery, PANEL_QUERY_REQUEST_FIELDS } from "../../datasources/test/fakeDatasources";
import type { VariableOption } from "../api";
import type { DashboardModel } from "../model";

/**
 * Fake folder and dashboard routes, written from docs/api/settings-dashboards.md (stream B), not
 * from the UI's own types: lists are `Page<T>`, folders come as a tree, unknown body fields and
 * query parameters answer 422, `version_conflict` carries the stored resource as `current`, and
 * trash, restore and purge behave as documented. Restricted folders exist only for members with
 * `folders:permissions`. The panel query and variable option routes (stream C) follow
 * docs/ARCHITECTURE.md.
 */

export interface StoredFolder {
  id: string;
  parentId: string | null;
  name: string;
  restricted: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface StoredVersion {
  version: number;
  message: string;
  authorId: string | null;
  authorName: string | null;
  restoredFrom: number | null;
  createdAt: number;
  model: DashboardModel;
}

export interface StoredDashboard {
  id: string;
  folderId: string | null;
  createdAt: number;
  createdBy: string | null;
  deletedAt: number | null;
  versions: StoredVersion[];
}

export interface FakeDashboardsState {
  folders: StoredFolder[];
  dashboards: StoredDashboard[];
  variableOptions: Record<string, VariableOption[]>;
  /** Resource grants per dashboard id, extending the caller's role on that dashboard. */
  grants: Record<string, { write?: boolean; delete?: boolean }>;
  /** Data sources the caller may see but not query (a grant taken away). */
  unqueryable: string[];
  /** Variables whose options answer says more exist than were sent. */
  truncatedOptions: string[];
  /** The organization setting `dashboards.default_time_range`, applied on create. */
  orgDefaultTimeRange: { from: string; to: string };
  /** Titles of dashboards created without a time range of their own. */
  createdWithoutRange: string[];
  /** Every request of the options route, to check what was asked and how often. */
  variableRequests: { name: string; body: Record<string, unknown> }[];
  /** Every panel query request, with the panel it was for. */
  panelQueries: { dashboardId: string; panelId: string; body: PanelQueryRequest }[];
  /** Every panel export request (docs/api/datasources.md, "Export"). */
  panelExports: { dashboardId: string; panelId: string; body: Record<string, unknown> }[];
  /** Holds every panel query until the test calls `release`, to observe loading and limits. */
  holdPanelQueries: boolean;
  release: () => void;
}

const AUTHOR = { id: "u1", name: "Ada Lovelace" };
const CREATED = Date.UTC(2026, 9, 1);

export function latest(dashboard: StoredDashboard): StoredVersion {
  return dashboard.versions.at(-1) as StoredVersion;
}

export function addFolder(
  state: FakeDashboardsState,
  id: string,
  name: string,
  options: { parentId?: string | null; restricted?: boolean } = {},
): StoredFolder {
  const folder: StoredFolder = {
    id,
    parentId: options.parentId ?? null,
    name,
    restricted: options.restricted ?? false,
    version: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    deletedAt: null,
  };
  state.folders.push(folder);
  return folder;
}

/** Adds a dashboard with one stored version and returns it. */
export function addDashboard(
  state: FakeDashboardsState,
  id: string,
  model: DashboardModel,
  options: { folderId?: string | null } = {},
): StoredDashboard {
  const dashboard: StoredDashboard = {
    id,
    folderId: options.folderId ?? null,
    createdAt: CREATED,
    createdBy: AUTHOR.id,
    deletedAt: null,
    versions: [
      {
        version: 1,
        message: "",
        authorId: AUTHOR.id,
        authorName: AUTHOR.name,
        restoredFrom: null,
        createdAt: CREATED,
        model,
      },
    ],
  };
  state.dashboards.push(dashboard);
  return dashboard;
}

function summary(d: StoredDashboard) {
  const current = latest(d);
  return {
    id: d.id,
    folderId: d.folderId,
    title: current.model.title,
    version: current.version,
    createdAt: d.createdAt,
    updatedAt: current.createdAt,
    updatedBy: current.authorId,
    deletedAt: d.deletedAt,
    tags: current.model.tags ?? [],
  };
}

function detail(d: StoredDashboard, areas?: FakeAreaStates) {
  // The library panels the model references, as the server answers them.
  const libraryPanels: Record<string, unknown> = {};
  for (const panel of latest(d).model.panels) {
    const linked = areas?.dashboardFeatures.libraryPanels.find(
      (l) => l.id === panel.libraryPanelId,
    );
    if (linked !== undefined) {
      libraryPanels[linked.id] = {
        id: linked.id,
        name: linked.name,
        version: linked.version,
        model: linked.model,
      };
    }
  }
  return { ...summary(d), model: latest(d).model, createdBy: d.createdBy, libraryPanels };
}

function folderView(f: StoredFolder) {
  const { id, parentId, name, restricted, version, createdAt, updatedAt, deletedAt } = f;
  return { id, parentId, name, restricted, version, createdAt, updatedAt, deletedAt };
}

/** The first field of `body` the route does not know, as the server reports it. */
function unknownField(body: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(body).find((key) => !allowed.includes(key));
}

function unknownParam(search: URLSearchParams, allowed: string[]): string | undefined {
  return [...search.keys()].find((key) => !allowed.includes(key));
}

const MODEL_FIELDS = [
  "schemaVersion",
  "title",
  "timeRange",
  "refreshSeconds",
  "variables",
  "panels",
  "tags",
  "rows",
  "annotations",
  "links",
  "timeZone",
  "weekStart",
  "fiscalYearStartMonth",
  "nowDelay",
  "refreshIntervals",
  "sharedCursor",
];
const PANEL_FIELDS = [
  "id",
  "type",
  "title",
  "grid",
  "targets",
  "transformations",
  "options",
  "fieldConfig",
  "rowId",
  "repeat",
  "timeFrom",
  "timeShift",
  "links",
  "libraryPanelId",
];
const VARIABLE_FIELDS = [
  "name",
  "type",
  "label",
  "datasourceId",
  "query",
  "options",
  "current",
  "multi",
];
const VARIABLE_TYPES = ["query", "custom", "constant", "textbox", "interval"];

/** The documented model checks that matter to the UI; a message names the place like the server. */
export function modelProblem(model: unknown): string | null {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    return "model: not an object";
  }
  const m = model as Record<string, unknown>;
  const extra = unknownField(m, MODEL_FIELDS);
  if (extra !== undefined) return `model.${extra}: unknown field`;
  if (m.schemaVersion !== 1 && m.schemaVersion !== 2) return "model.schemaVersion: must be 1 or 2";
  if (typeof m.title !== "string" || m.title.length < 1 || m.title.length > 200) {
    return "model.title: 1 to 200 characters";
  }
  const range = m.timeRange as Record<string, unknown> | undefined;
  if (typeof range?.from !== "string" || typeof range.to !== "string") {
    return "model.timeRange: from and to are required";
  }
  for (const [i, variable] of ((m.variables ?? []) as Record<string, unknown>[]).entries()) {
    const field = unknownField(variable, VARIABLE_FIELDS);
    if (field !== undefined) return `model.variables[${i}].${field}: unknown field`;
    if (!VARIABLE_TYPES.includes(String(variable.type))) return `model.variables[${i}].type`;
    if ((variable.type === "query") !== (variable.datasourceId !== undefined)) {
      return `model.variables[${i}].datasourceId: only and always for query variables`;
    }
  }
  const ids = new Set<string>();
  for (const [i, panel] of ((m.panels ?? []) as Record<string, unknown>[]).entries()) {
    const field = unknownField(panel, PANEL_FIELDS);
    if (field !== undefined) return `model.panels[${i}].${field}: unknown field`;
    const grid = panel.grid as { x: number; y: number; w: number; h: number };
    if (
      grid.w < 1 ||
      grid.w > 24 ||
      grid.x < 0 ||
      grid.x + grid.w > 24 ||
      grid.h < 1 ||
      grid.h > 200
    ) {
      return `model.panels[${i}].grid: out of range`;
    }
    if (ids.has(String(panel.id))) return `model.panels[${i}].id: not unique`;
    ids.add(String(panel.id));
    if (panel.libraryPanelId !== undefined && ((panel.targets ?? []) as unknown[]).length > 0) {
      return `model.panels[${i}].targets must be empty: the library panel holds the queries`;
    }
    if (
      panel.libraryPanelId !== undefined &&
      (((panel.transformations ?? []) as unknown[]).length > 0 ||
        ((panel.links ?? []) as unknown[]).length > 0)
    ) {
      return `model.panels[${i}].transformations and links must be empty on a library panel slot`;
    }
    for (const [j, link] of ((panel.links ?? []) as { url: string }[]).entries()) {
      if (!/^(https?:\/\/|mailto:|\/(?!\/))/i.test(link.url)) {
        return `model.panels[${i}].links[${j}].url must start with http://, https://, mailto: or /`;
      }
    }
  }
  for (const [i, link] of ((m.links ?? []) as { type: string; url?: string }[]).entries()) {
    if (link.type === "url" && !/^(https?:\/\/|mailto:|\/(?!\/))/i.test(link.url ?? "")) {
      return `model.links[${i}].url must start with http://, https://, mailto: or /`;
    }
  }
  return null;
}

/**
 * The stored-query variable rules (docs/api/datasources.md, "Variables"): only variables the
 * dashboard defines, no value for a constant, and a custom value must be one of its options.
 */
function variablesProblem(model: DashboardModel, sent: unknown): boolean {
  for (const [name, value] of Object.entries((sent ?? {}) as Record<string, unknown>)) {
    const variable = model.variables.find((v) => v.name === name);
    if (variable === undefined || variable.type === "constant") {
      return true;
    }
    if (variable.type === "custom") {
      const options = (Array.isArray(variable.options) ? variable.options : []).map((o) =>
        typeof o === "object" && o !== null ? String((o as { value?: unknown }).value) : String(o),
      );
      const values = Array.isArray(value) ? value : [value];
      if (!values.every((v) => options.includes(String(v)))) {
        return true;
      }
    }
  }
  return false;
}

function validation(field: string, message = `invalid ${field}`): Response {
  return json(422, { error: { code: "validation", message, field } });
}

export function dashboardsFake(areas: FakeAreaStates): FakeArea<FakeDashboardsState> {
  let nextId = 1;
  let waiting: (() => void)[] = [];
  const state: FakeDashboardsState = {
    folders: [],
    dashboards: [],
    variableOptions: {},
    grants: {},
    unqueryable: [],
    truncatedOptions: [],
    orgDefaultTimeRange: { from: "now-6h", to: "now" },
    createdWithoutRange: [],
    variableRequests: [],
    panelQueries: [],
    panelExports: [],
    holdPanelQueries: false,
    release: () => {
      state.holdPanelQueries = false;
      const pending = waiting;
      waiting = [];
      for (const resolve of pending) {
        resolve();
      }
    },
  };

  const folderById = (id: string | null) =>
    id === null ? undefined : state.folders.find((f) => f.id === id);

  /** Restricted here or above: such folders exist only for members who manage permissions. */
  function restrictedChain(id: string | null): boolean {
    for (let f = folderById(id); f !== undefined; f = folderById(f.parentId)) {
      if (f.restricted) return true;
    }
    return false;
  }

  function trashedChain(id: string | null): boolean {
    for (let f = folderById(id); f !== undefined; f = folderById(f.parentId)) {
      if (f.deletedAt !== null) return true;
    }
    return false;
  }

  function subtree(id: string): StoredFolder[] {
    const all = state.folders.filter((f) => f.id === id);
    for (let i = 0; i < all.length; i++) {
      all.push(...state.folders.filter((f) => f.parentId === all[i]?.id));
    }
    return all;
  }

  function handle(request: FakeRequest): Response | undefined | Promise<Response | undefined> {
    const { method, route, search, body, permissions } = request;
    const parts = route.split("/").slice(4);
    const can = (permission: string) => permissions.has(permission);
    // What the caller may do with one item: the role, extended by resource grants (the
    // `access` booleans stream B adds to the answers).
    const accessOf = (d: StoredDashboard) => {
      const grant = state.grants[d.id] ?? {};
      return {
        write: can("dashboards:write") || grant.write === true,
        delete: can("dashboards:delete") || grant.delete === true,
        permissions: can("dashboards:share"),
      };
    };
    // Saving checks datasources:query on the sources of new or changed queries only, compared
    // with the stored version (docs/api/datasources.md); any change to a variable definition
    // counts as a change of every query. A source the caller cannot see (or that does not
    // exist) is 422 on model, one they see but may not query is 403 naming it.
    const datasourceCheck = (model: DashboardModel, stored?: DashboardModel): Response | null => {
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const allChanged = stored === undefined || !same(model.variables, stored.variables);
      const storedTarget = (panelId: string, refId: string) =>
        stored?.panels.find((p) => p.id === panelId)?.targets.find((t) => t.refId === refId);
      const ids = [
        ...model.panels.flatMap((p) =>
          p.targets
            .filter((t) => {
              const before = storedTarget(p.id, t.refId);
              return (
                allChanged ||
                before === undefined ||
                !same([before.datasourceId, before.query], [t.datasourceId, t.query])
              );
            })
            .map((t) => t.datasourceId),
        ),
        ...(allChanged
          ? model.variables.flatMap((v) => (v.datasourceId === undefined ? [] : [v.datasourceId]))
          : []),
      ];
      const grants = areas.datasources.grants;
      for (const id of ids) {
        const exists = areas.datasources.datasources.some(
          (d) => d.id === id && d.deletedAt === undefined,
        );
        const sees =
          can("datasources:read") || can("datasources:query") || grants[id] !== undefined;
        if (!exists || !sees) {
          return validation("model", `data source ${id} does not exist`);
        }
        const granted = grants[id] !== undefined;
        if ((!can("datasources:query") && !granted) || state.unqueryable.includes(id)) {
          return json(403, {
            error: { code: "forbidden", message: `no query right on data source ${id}` },
          });
        }
      }
      return null;
    };
    const dashboardAnswer = (d: StoredDashboard) => ({ ...detail(d, areas), access: accessOf(d) });
    const folderAnswer = (f: StoredFolder) => ({
      ...folderView(f),
      access: {
        // A folder grant (in `grants` by folder id) extends the role, as for dashboards.
        write: can("folders:write") || state.grants[f.id]?.write === true,
        delete: can("folders:write"),
        permissions: can("folders:permissions"),
      },
    });
    const allowed = (d: StoredDashboard, what: "write" | "delete") =>
      accessOf(d)[what] ? null : error(403, "forbidden");
    const visible = (folderId: string | null) =>
      folderId === null || can("folders:permissions") || !restrictedChain(folderId);

    if (parts[0] === "folders") {
      if (!can(parts.length === 1 && method === "GET" ? "folders:read" : "folders:write")) {
        return error(403, "forbidden");
      }
      if (parts.length === 1 && method === "GET") {
        const extra = unknownParam(search, ["trashed", "limit", "cursor"]);
        if (extra !== undefined) return validation(extra);
        if (search.get("trashed") === "true") {
          const items = state.folders
            .filter((f) => f.deletedAt !== null && visible(f.id) && !trashedChain(f.parentId))
            .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
            .map((f) => ({ ...folderAnswer(f), children: [] }));
          return json(200, { items, nextCursor: null });
        }
        const tree = (parentId: string | null): unknown[] =>
          state.folders
            .filter((f) => f.parentId === parentId && f.deletedAt === null && visible(f.id))
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
            .map((f) => ({ ...folderAnswer(f), children: tree(f.id) }));
        return json(200, { items: tree(null), nextCursor: null });
      }
      if (parts.length === 1 && method === "POST") {
        const extra = unknownField(body, ["name", "parentId", "restricted"]);
        if (extra !== undefined) return validation(extra);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (name.length < 1 || name.length > 100) return validation("name");
        const parentId = (body.parentId as string | null | undefined) ?? null;
        if (parentId !== null && (folderById(parentId) === undefined || !visible(parentId))) {
          return error(404, "not_found");
        }
        if (body.restricted === true && !can("folders:permissions")) return error(403, "forbidden");
        const created = addFolder(state, `folder-new-${nextId++}`, name, {
          parentId,
          restricted: body.restricted === true,
        });
        return json(201, folderAnswer(created));
      }
      const folder = folderById(decodeURIComponent(parts[1] ?? ""));
      if (folder === undefined || !visible(folder.id)) {
        return error(404, "not_found");
      }
      if (parts.length === 2 && method === "PATCH") {
        const extra = unknownField(body, ["version", "name", "parentId", "restricted"]);
        if (extra !== undefined) return validation(extra);
        if (folder.deletedAt !== null) return error(409, "conflict");
        if (body.restricted !== undefined && !can("folders:permissions")) {
          return error(403, "forbidden");
        }
        if (body.version !== folder.version) {
          return json(409, {
            error: { code: "version_conflict", message: "a newer version exists" },
            current: folderAnswer(folder),
          });
        }
        if (body.parentId !== undefined && subtree(folder.id).some((f) => f.id === body.parentId)) {
          return validation("parentId");
        }
        if (typeof body.name === "string") folder.name = body.name.trim();
        if (body.parentId !== undefined) folder.parentId = body.parentId as string | null;
        if (typeof body.restricted === "boolean") folder.restricted = body.restricted;
        folder.version++;
        return json(200, folderAnswer(folder));
      }
      if (parts.length === 2 && method === "DELETE") {
        const ids = new Set(subtree(folder.id).map((f) => f.id));
        const contained = state.dashboards.filter(
          (d) => d.folderId !== null && ids.has(d.folderId),
        );
        if (contained.length > 0 && !can("dashboards:delete")) return error(403, "forbidden");
        const now = Date.now();
        for (const f of subtree(folder.id)) f.deletedAt ??= now;
        for (const d of contained) d.deletedAt ??= now;
        return new Response(null, { status: 204 });
      }
      if (parts[2] === "restore" && method === "POST") {
        if (trashedChain(folder.parentId)) return error(409, "conflict");
        const at = folder.deletedAt;
        if (at !== null) {
          const ids = new Set(subtree(folder.id).map((f) => f.id));
          for (const f of subtree(folder.id)) if (f.deletedAt === at) f.deletedAt = null;
          for (const d of state.dashboards) {
            if (d.folderId !== null && ids.has(d.folderId) && d.deletedAt === at)
              d.deletedAt = null;
          }
        }
        return json(200, folderAnswer(folder));
      }
      if (parts[2] === "purge" && method === "DELETE") {
        if (folder.deletedAt === null) return error(409, "conflict");
        const ids = new Set(subtree(folder.id).map((f) => f.id));
        state.folders = state.folders.filter((f) => !ids.has(f.id));
        state.dashboards = state.dashboards.filter(
          (d) => d.folderId === null || !ids.has(d.folderId),
        );
        return new Response(null, { status: 204 });
      }
      return undefined;
    }

    if (parts[0] !== "dashboards") {
      return undefined;
    }
    if (parts.length === 1 && method === "GET") {
      if (!can("dashboards:read")) return error(403, "forbidden");
      const extra = unknownParam(search, ["folderId", "q", "trashed", "tag", "limit", "cursor"]);
      if (extra !== undefined) return validation(extra);
      const folderId = search.get("folderId");
      if (folderId !== null && (folderById(folderId) === undefined || !visible(folderId))) {
        return error(404, "not_found");
      }
      const trashed = search.get("trashed") === "true";
      const q = (search.get("q") ?? "").toLowerCase();
      const items = state.dashboards
        .filter((d) => (trashed ? d.deletedAt !== null : d.deletedAt === null))
        .filter((d) => visible(d.folderId) && (trashed || !trashedChain(d.folderId)))
        .filter((d) => folderId === null || d.folderId === folderId)
        .filter((d) => latest(d).model.title.toLowerCase().includes(q))
        .filter((d) => {
          const tag = search.get("tag");
          return (
            tag === null ||
            (latest(d).model.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase())
          );
        })
        .map((d) => ({ ...summary(d), access: accessOf(d) }))
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      return json(200, { items, nextCursor: null });
    }
    if (parts.length === 1 && method === "POST") {
      // Creating needs dashboards:write, or a write grant on the target folder.
      const into = typeof body.folderId === "string" ? body.folderId : null;
      if (!can("dashboards:write") && !(into !== null && state.grants[into]?.write === true)) {
        return error(403, "forbidden");
      }
      const extra = unknownField(body, ["model", "folderId", "message"]);
      if (extra !== undefined) return validation(extra);
      // Created without a time range, a dashboard gets the organization's default (stream B).
      const sent = body.model as Record<string, unknown> | undefined;
      let model: unknown = sent;
      if (sent !== undefined && sent.timeRange === undefined) {
        state.createdWithoutRange.push(String(sent.title));
        model = { ...sent, timeRange: { ...state.orgDefaultTimeRange } };
      }
      const problem = modelProblem(model);
      if (problem !== null) return validation("model", problem);
      const refused = datasourceCheck(model as DashboardModel);
      if (refused !== null) return refused;
      const folderId = (body.folderId as string | null | undefined) ?? null;
      if (folderId !== null && (folderById(folderId) === undefined || !visible(folderId))) {
        return error(404, "not_found");
      }
      const created = addDashboard(state, `dash-new-${nextId++}`, model as DashboardModel, {
        folderId,
      });
      latest(created).message = typeof body.message === "string" ? body.message : "";
      latest(created).createdAt = Date.now();
      return json(201, dashboardAnswer(created));
    }
    const dashboard = state.dashboards.find((d) => d.id === decodeURIComponent(parts[1] ?? ""));
    if (dashboard === undefined || !visible(dashboard.folderId)) {
      return error(404, "not_found");
    }
    const needs = (permission: string) => (can(permission) ? null : error(403, "forbidden"));
    if (parts.length === 2 && method === "GET") {
      return needs("dashboards:read") ?? json(200, dashboardAnswer(dashboard));
    }
    if (parts[2] === "panels" && parts[4] === "query" && method === "POST") {
      return (
        needs("dashboards:read") ?? panelQuery(dashboard, decodeURIComponent(parts[3] ?? ""), body)
      );
    }
    if (parts[2] === "panels" && parts[4] === "export" && method === "POST") {
      // data:export on the route, then dashboards:read on the dashboard, as on the server.
      const denied = needs("data:export") ?? needs("dashboards:read");
      if (denied !== null) return denied;
      const panelId = decodeURIComponent(parts[3] ?? "");
      if (!latest(dashboard).model.panels.some((p) => p.id === panelId)) {
        return error(404, "not_found");
      }
      const extra = unknownField(body, [
        "timeRange",
        "intervalMs",
        "maxDataPoints",
        "variables",
        "format",
        "language",
        "frame",
      ]);
      if (extra !== undefined) return validation(extra);
      state.panelExports.push({ dashboardId: dashboard.id, panelId, body });
      return new Response("﻿a;b\r\n1;2,5\r\n", {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="Orders.csv"',
        },
      });
    }
    if (parts[2] === "variables" && parts[4] === "options" && method === "POST") {
      // The decided contract: VariableOptionsRequest {timeRange, variables} without the
      // variable's own name; the answer {options, truncated}; a variable the saved dashboard
      // does not have is 404.
      const denied = needs("dashboards:read");
      if (denied !== null) return denied;
      const extra = unknownField(body, ["timeRange", "variables"]);
      if (extra !== undefined) return validation(extra);
      const name = decodeURIComponent(parts[3] ?? "");
      const variable = latest(dashboard).model.variables.find((v) => v.name === name);
      if (variable === undefined || variable.type !== "query") return error(404, "not_found");
      if (variablesProblem(latest(dashboard).model, body.variables)) return validation("variables");
      if (name in ((body.variables ?? {}) as Record<string, unknown>))
        return validation("variables");
      state.variableRequests.push({ name, body });
      const options = state.variableOptions[name] ?? [];
      return json(200, { options, truncated: state.truncatedOptions.includes(name) });
    }
    if (parts[2] === "versions" && method === "GET") {
      const denied = needs("dashboards:read");
      if (denied !== null) return denied;
      if (parts.length === 3) {
        const items = [...dashboard.versions].reverse().map(({ model: _model, ...rest }) => rest);
        return json(200, { items, nextCursor: null });
      }
      const version = dashboard.versions.find((v) => v.version === Number(parts[3]));
      return version === undefined ? error(404, "not_found") : json(200, version);
    }
    if (parts[2] === "versions" && parts[4] === "restore" && method === "POST") {
      const denied = allowed(dashboard, "write");
      if (denied !== null) return denied;
      if (dashboard.deletedAt !== null) return error(409, "conflict");
      const version = dashboard.versions.find((v) => v.version === Number(parts[3]));
      if (version === undefined) return error(404, "not_found");
      dashboard.versions.push({
        version: latest(dashboard).version + 1,
        message: "",
        authorId: AUTHOR.id,
        authorName: AUTHOR.name,
        restoredFrom: version.version,
        createdAt: Date.now(),
        model: version.model,
      });
      return json(200, dashboardAnswer(dashboard));
    }
    if (parts.length === 2 && method === "PUT") {
      const denied = allowed(dashboard, "write");
      if (denied !== null) return denied;
      const extra = unknownField(body, ["model", "version", "message", "folderId"]);
      if (extra !== undefined) return validation(extra);
      if (dashboard.deletedAt !== null) return error(409, "conflict");
      const problem = modelProblem(body.model);
      if (problem !== null) return validation("model", problem);
      const refused = datasourceCheck(body.model as DashboardModel, latest(dashboard).model);
      if (refused !== null) return refused;
      if (body.version !== latest(dashboard).version) {
        return json(409, {
          error: { code: "version_conflict", message: "a newer version exists" },
          current: dashboardAnswer(dashboard),
        });
      }
      if (body.folderId !== undefined) dashboard.folderId = body.folderId as string | null;
      dashboard.versions.push({
        version: latest(dashboard).version + 1,
        message: typeof body.message === "string" ? body.message : "",
        authorId: AUTHOR.id,
        authorName: AUTHOR.name,
        restoredFrom: null,
        createdAt: Date.now(),
        model: body.model as DashboardModel,
      });
      return json(200, dashboardAnswer(dashboard));
    }
    if (parts.length === 2 && method === "DELETE") {
      const denied = allowed(dashboard, "delete");
      if (denied !== null) return denied;
      dashboard.deletedAt ??= Date.now();
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "restore" && method === "POST") {
      const denied = allowed(dashboard, "delete");
      if (denied !== null) return denied;
      if (trashedChain(dashboard.folderId)) return error(409, "conflict");
      dashboard.deletedAt = null;
      return json(200, dashboardAnswer(dashboard));
    }
    if (parts[2] === "purge" && method === "DELETE") {
      const denied = allowed(dashboard, "delete");
      if (denied !== null) return denied;
      if (dashboard.deletedAt === null) return error(409, "conflict");
      state.dashboards = state.dashboards.filter((d) => d !== dashboard);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  async function panelQuery(
    dashboard: StoredDashboard,
    panelId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const panel = latest(dashboard).model.panels.find((p) => p.id === panelId);
    if (panel === undefined) {
      return error(404, "not_found");
    }
    const extra = unknownField(body, PANEL_QUERY_REQUEST_FIELDS);
    if (extra !== undefined) {
      return validation(extra);
    }
    if (variablesProblem(latest(dashboard).model, body.variables)) {
      return validation("variables");
    }
    const query = body as unknown as PanelQueryRequest;
    state.panelQueries.push({ dashboardId: dashboard.id, panelId, body: query });
    if (state.holdPanelQueries) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    const results: Record<string, QueryOutcome> = {};
    // A library panel's queries are its own (docs/api/dashboard-features.md).
    const linked = areas.dashboardFeatures.libraryPanels.find((l) => l.id === panel.libraryPanelId);
    const targets =
      linked === undefined ? panel.targets : ((linked.model.targets ?? []) as typeof panel.targets);
    for (const target of targets) {
      results[target.refId] = await answerQuery(
        areas.datasources,
        { refId: target.refId, datasourceId: target.datasourceId, query: target.query },
        query.timeRange,
        query.variables,
      );
    }
    return json(200, { results });
  }

  return { state, handle };
}
