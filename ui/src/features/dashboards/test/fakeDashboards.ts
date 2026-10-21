import type { PanelQueryRequest, QueryOutcome } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import { answerQuery } from "../../datasources/test/fakeDatasources";
import type { VariableOption } from "../api";
import type { DashboardModel } from "../model";

/**
 * Fake routes for folders, dashboards, versions, the panel query route and variable options.
 * Restricted folders the caller has no grant for are simply absent (`hidden`), as on the server;
 * a dashboard save with an old version answers 409 `version_conflict` with the stored one.
 */

export interface StoredFolder {
  id: string;
  parentId: string | null;
  name: string;
  restricted: boolean;
  canEdit: boolean;
  version: number;
  /** Not visible to the caller at all, like a restricted folder without a grant. */
  hidden?: boolean;
  deletedAt?: number;
}

export interface StoredVersion {
  version: number;
  createdAt: number;
  createdBy: string;
  message: string;
  model: DashboardModel;
}

export interface StoredDashboard {
  id: string;
  title: string;
  folderId: string | null;
  canEdit: boolean;
  versions: StoredVersion[];
  updatedBy: string;
  deletedAt?: number;
}

export interface FakeDashboardsState {
  folders: StoredFolder[];
  dashboards: StoredDashboard[];
  variableOptions: Record<string, VariableOption[]>;
  /** Every panel query request, with the panel it was for. */
  panelQueries: { dashboardId: string; panelId: string; body: PanelQueryRequest }[];
  /** Holds every panel query until the test calls `release`, to observe loading and limits. */
  holdPanelQueries: boolean;
  release: () => void;
}

export function latest(dashboard: StoredDashboard): StoredVersion {
  return dashboard.versions.at(-1) as StoredVersion;
}

/** Adds a dashboard with one stored version and returns it. */
export function addDashboard(
  state: FakeDashboardsState,
  id: string,
  model: DashboardModel,
  options: { folderId?: string | null; canEdit?: boolean } = {},
): StoredDashboard {
  const dashboard: StoredDashboard = {
    id,
    title: model.title,
    folderId: options.folderId ?? null,
    canEdit: options.canEdit ?? true,
    updatedBy: "Ada Lovelace",
    versions: [
      {
        version: 1,
        createdAt: Date.UTC(2026, 9, 1),
        createdBy: "Ada Lovelace",
        message: "",
        model,
      },
    ],
  };
  state.dashboards.push(dashboard);
  return dashboard;
}

function detail(dashboard: StoredDashboard) {
  const current = latest(dashboard);
  return {
    id: dashboard.id,
    title: dashboard.title,
    folderId: dashboard.folderId,
    version: current.version,
    model: current.model,
    canEdit: dashboard.canEdit,
  };
}

export function dashboardsFake(areas: FakeAreaStates): FakeArea<FakeDashboardsState> {
  let nextId = 1;
  let waiting: (() => void)[] = [];
  const state: FakeDashboardsState = {
    folders: [],
    dashboards: [],
    variableOptions: {},
    panelQueries: [],
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

  const visibleFolder = (id: string | null) =>
    id === null ||
    state.folders.some((f) => f.id === id && f.hidden !== true && f.deletedAt === undefined);
  const findDashboard = (id: string) =>
    state.dashboards.find(
      (d) => d.id === id && d.deletedAt === undefined && visibleFolder(d.folderId),
    );

  async function handle(request: FakeRequest): Promise<Response | undefined> {
    const { method, route, search, body, permissions } = request;
    const parts = route.split("/").slice(4);
    const can = (permission: string) => permissions.has(permission);

    if (parts[0] === "folders") {
      const folder = state.folders.find(
        (f) =>
          f.id === parts[1] &&
          f.hidden !== true &&
          (f.deletedAt === undefined || parts[2] === "restore"),
      );
      if (parts.length === 1 && method === "GET") {
        const items = state.folders.filter((f) => f.hidden !== true && f.deletedAt === undefined);
        return json(
          200,
          items.map(({ id, parentId, name, restricted, canEdit, version }) => ({
            id,
            parentId,
            name,
            restricted,
            canEdit,
            version,
          })),
        );
      }
      if (parts.length === 1 && method === "POST") {
        if (!can("folders:write")) {
          return error(403, "forbidden");
        }
        state.folders.push({
          id: `folder-new-${nextId++}`,
          parentId: (body.parentId as string | null) ?? null,
          name: String(body.name),
          restricted: false,
          canEdit: true,
          version: 1,
        });
        return json(201, {});
      }
      if (folder === undefined) {
        return error(404, "not_found");
      }
      if (!can("folders:write")) {
        return error(403, "forbidden");
      }
      if (parts.length === 2 && method === "PATCH") {
        if (body.version !== folder.version) {
          return error(409, "version_conflict");
        }
        if (body.restricted !== undefined && !can("folders:permissions")) {
          return error(403, "forbidden");
        }
        if (typeof body.name === "string") folder.name = body.name;
        if (body.parentId !== undefined) folder.parentId = body.parentId as string | null;
        if (typeof body.restricted === "boolean") folder.restricted = body.restricted;
        folder.version++;
        return json(200, {});
      }
      if (parts.length === 2 && method === "DELETE") {
        folder.deletedAt = Date.now();
        return new Response(null, { status: 204 });
      }
      if (parts[2] === "restore" && method === "POST") {
        delete folder.deletedAt;
        return new Response(null, { status: 204 });
      }
      return undefined;
    }

    if (parts[0] !== "dashboards") {
      return undefined;
    }
    if (!can("dashboards:read")) {
      return error(403, "forbidden");
    }
    if (parts.length === 1 && method === "GET") {
      const deleted = search.get("deleted") === "true";
      const folderId = search.get("folderId");
      const q = (search.get("q") ?? "").toLowerCase();
      const items = state.dashboards
        .filter((d) => (deleted ? d.deletedAt !== undefined : d.deletedAt === undefined))
        .filter((d) => visibleFolder(d.folderId))
        .filter((d) => folderId === null || d.folderId === folderId)
        .filter((d) => d.title.toLowerCase().includes(q))
        .map((d) => ({
          id: d.id,
          title: d.title,
          folderId: d.folderId,
          updatedAt: latest(d).createdAt,
          updatedBy: d.updatedBy,
          ...(d.deletedAt === undefined ? {} : { deletedAt: d.deletedAt }),
        }));
      return json(200, { items, nextCursor: null });
    }
    if (parts.length === 1 && method === "POST") {
      if (!can("dashboards:write")) {
        return error(403, "forbidden");
      }
      const created = addDashboard(state, `dash-new-${nextId++}`, body.model as DashboardModel, {
        folderId: (body.folderId as string | null) ?? null,
      });
      created.title = String(body.title);
      return json(201, detail(created));
    }
    const id = decodeURIComponent(parts[1] ?? "");
    if (parts[2] === "restore" && method === "POST") {
      const trashed = state.dashboards.find((d) => d.id === id && d.deletedAt !== undefined);
      if (trashed === undefined) {
        return error(404, "not_found");
      }
      delete trashed.deletedAt;
      return new Response(null, { status: 204 });
    }
    const dashboard = findDashboard(id);
    if (dashboard === undefined) {
      return error(404, "not_found");
    }
    if (parts.length === 2 && method === "GET") {
      return json(200, detail(dashboard));
    }
    if (parts[2] === "panels" && parts[4] === "query" && method === "POST") {
      const panelId = decodeURIComponent(parts[3] ?? "");
      const panel = latest(dashboard).model.panels.find((p) => p.id === panelId);
      if (panel === undefined) {
        return error(404, "not_found");
      }
      const query = body as unknown as PanelQueryRequest;
      state.panelQueries.push({ dashboardId: id, panelId, body: query });
      if (state.holdPanelQueries) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      const results: Record<string, QueryOutcome> = {};
      for (const target of panel.targets) {
        results[target.refId] = await answerQuery(
          areas.datasources,
          { refId: target.refId, datasourceId: target.datasourceId, query: target.query },
          query.timeRange,
        );
      }
      return json(200, { results });
    }
    if (parts[2] === "variables" && parts[4] === "options" && method === "POST") {
      return json(200, {
        options: state.variableOptions[decodeURIComponent(parts[3] ?? "")] ?? [],
      });
    }
    if (parts[2] === "versions" && method === "GET") {
      if (parts.length === 3) {
        const items = [...dashboard.versions]
          .reverse()
          .map(({ version, createdAt, createdBy, message }) => ({
            version,
            createdAt,
            createdBy,
            message,
          }));
        return json(200, { items, nextCursor: null });
      }
      const version = dashboard.versions.find((v) => v.version === Number(parts[3]));
      return version === undefined ? error(404, "not_found") : json(200, version);
    }
    if (!can("dashboards:write") || !dashboard.canEdit) {
      return error(403, "forbidden");
    }
    if (parts[2] === "versions" && parts[4] === "restore" && method === "POST") {
      const version = dashboard.versions.find((v) => v.version === Number(parts[3]));
      if (version === undefined) {
        return error(404, "not_found");
      }
      dashboard.versions.push({
        ...version,
        version: latest(dashboard).version + 1,
        createdAt: Date.now(),
        message: `Restored version ${version.version}`,
      });
      return new Response(null, { status: 204 });
    }
    if (parts.length === 2 && method === "PUT") {
      if (body.version !== latest(dashboard).version) {
        return json(409, {
          error: { code: "version_conflict", message: "a newer version exists" },
          current: detail(dashboard),
        });
      }
      const model = body.model as DashboardModel;
      dashboard.versions.push({
        version: latest(dashboard).version + 1,
        createdAt: Date.now(),
        createdBy: "Ada Lovelace",
        message: String(body.message ?? ""),
        model,
      });
      dashboard.title = model.title;
      return json(200, detail(dashboard));
    }
    if (parts.length === 2 && method === "DELETE") {
      if (!can("dashboards:delete")) {
        return error(403, "forbidden");
      }
      dashboard.deletedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  return { state, handle };
}
