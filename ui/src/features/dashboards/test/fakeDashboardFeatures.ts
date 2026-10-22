import type { QueryOutcome, TimeRange } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import { answerQuery } from "../../datasources/test/fakeDatasources";
import { latest, modelProblem } from "./fakeDashboards";

/**
 * Fake routes of docs/api/dashboard-features.md, written from that document: annotations with
 * versions, annotation queries run as stored queries, playlists that leave out dashboards the
 * caller cannot see, library panels whose rights follow the folder and that cannot be deleted
 * while used, and the model check. Unknown body fields answer 422 as on the server.
 */

export interface StoredAnnotation {
  id: string;
  dashboardId: string;
  panelId: string | null;
  time: number;
  timeEnd: number | null;
  text: string;
  tags: string[];
  version: number;
}

export interface StoredPlaylist {
  id: string;
  name: string;
  intervalSeconds: number;
  items: ({ type: "dashboard"; dashboardId: string } | { type: "tag"; tag: string })[];
  version: number;
}

export interface StoredLibraryPanel {
  id: string;
  folderId: string | null;
  name: string;
  model: Record<string, unknown>;
  version: number;
}

export interface FakeDashboardFeaturesState {
  annotations: StoredAnnotation[];
  playlists: StoredPlaylist[];
  libraryPanels: StoredLibraryPanel[];
  /** Every request body of the annotation query route. */
  annotationQueryRequests: { queryId: string; body: Record<string, unknown> }[];
}

function unknownField(body: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(body).find((key) => !allowed.includes(key));
}

function validation(field: string, message = `invalid ${field}`): Response {
  return json(422, { error: { code: "validation", message, field } });
}

export function dashboardFeaturesFake(areas: FakeAreaStates): FakeArea<FakeDashboardFeaturesState> {
  let nextId = 1;
  const state: FakeDashboardFeaturesState = {
    annotations: [],
    playlists: [],
    libraryPanels: [],
    annotationQueryRequests: [],
  };

  /** Restricted here or above, as fakeDashboards decides it. */
  function hidden(folderId: string | null, can: (p: string) => boolean): boolean {
    if (can("folders:permissions")) return false;
    for (let id = folderId; id !== null; ) {
      const folder = areas.dashboards.folders.find((f) => f.id === id);
      if (folder === undefined) return false;
      if (folder.restricted) return true;
      id = folder.parentId;
    }
    return false;
  }

  function handle(request: FakeRequest): Response | undefined | Promise<Response | undefined> {
    const { method, route, search, body, permissions } = request;
    const parts = route.split("/").slice(4);
    const can = (permission: string) => permissions.has(permission);
    const dashboards = areas.dashboards;
    const visibleDashboard = (id: string) =>
      dashboards.dashboards.find((d) => d.id === id && !hidden(d.folderId, can));

    if (parts[0] === "dashboards" && parts[1] === "validate" && method === "POST") {
      const extra = unknownField(body, ["model"]);
      if (extra !== undefined) return validation(extra);
      const problem = modelProblem(body.model);
      if (problem !== null) return validation("model", problem);
      return json(200, { model: { ...(body.model as object), schemaVersion: 2 } });
    }

    if (
      parts[0] === "dashboards" &&
      (parts[2] === "annotations" || parts[2] === "annotation-queries")
    ) {
      const dashboard = visibleDashboard(decodeURIComponent(parts[1] ?? ""));
      if (dashboard === undefined || !can("dashboards:read")) return error(404, "not_found");
      const grant = dashboards.grants[dashboard.id] ?? {};
      const writes = can("annotations:write") || can("dashboards:write") || grant.write === true;
      if (parts[2] === "annotation-queries" && parts[4] === "query" && method === "POST") {
        const queryId = decodeURIComponent(parts[3] ?? "");
        const query = latest(dashboard).model.annotations?.find((a) => a.id === queryId);
        if (query === undefined) return error(404, "not_found");
        state.annotationQueryRequests.push({ queryId, body });
        return (async () => {
          const result: QueryOutcome = await answerQuery(
            areas.datasources,
            { refId: query.id, datasourceId: query.datasourceId, query: query.query },
            body.timeRange as TimeRange,
          );
          return json(200, { results: { [query.id]: result } });
        })();
      }
      if (parts.length === 3 && method === "GET") {
        const from = Number(search.get("from"));
        const to = Number(search.get("to"));
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return validation("from");
        const items = state.annotations
          .filter(
            (a) => a.dashboardId === dashboard.id && a.time <= to && (a.timeEnd ?? a.time) >= from,
          )
          .sort((a, b) => a.time - b.time);
        return json(200, { items, nextCursor: null });
      }
      if (!writes) return error(403, "forbidden");
      if (dashboard.deletedAt !== null) return error(409, "conflict");
      if (parts.length === 3 && method === "POST") {
        const extra = unknownField(body, ["time", "timeEnd", "text", "tags", "panelId"]);
        if (extra !== undefined) return validation(extra);
        if (typeof body.text !== "string" || body.text.trim() === "") return validation("text");
        if (
          typeof body.panelId === "string" &&
          !latest(dashboard).model.panels.some((p) => p.id === body.panelId)
        ) {
          return validation("panelId");
        }
        const annotation: StoredAnnotation = {
          id: `ann-${nextId++}`,
          dashboardId: dashboard.id,
          panelId: typeof body.panelId === "string" ? body.panelId : null,
          time: Number(body.time),
          timeEnd: typeof body.timeEnd === "number" ? body.timeEnd : null,
          text: body.text.trim(),
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
          version: 1,
        };
        state.annotations.push(annotation);
        return json(201, annotation);
      }
      const annotation = state.annotations.find(
        (a) => a.id === decodeURIComponent(parts[3] ?? "") && a.dashboardId === dashboard.id,
      );
      if (annotation === undefined) return error(404, "not_found");
      if (method === "PATCH") {
        const extra = unknownField(body, ["version", "time", "timeEnd", "text", "tags"]);
        if (extra !== undefined) return validation(extra);
        if (body.version !== annotation.version) {
          return json(409, {
            error: { code: "version_conflict", message: "a newer version exists" },
            current: annotation,
          });
        }
        if (typeof body.time === "number") annotation.time = body.time;
        if (body.timeEnd !== undefined) annotation.timeEnd = body.timeEnd as number | null;
        if (typeof body.text === "string") annotation.text = body.text;
        if (Array.isArray(body.tags)) annotation.tags = body.tags as string[];
        annotation.version++;
        return json(200, annotation);
      }
      if (method === "DELETE") {
        state.annotations = state.annotations.filter((a) => a !== annotation);
        return new Response(null, { status: 204 });
      }
      return undefined;
    }

    if (parts[0] === "playlists") {
      if (!can(method === "GET" ? "dashboards:read" : "dashboards:write"))
        return error(403, "forbidden");
      const sees = (item: StoredPlaylist["items"][number]) =>
        item.type === "tag" || visibleDashboard(item.dashboardId) !== undefined;
      const view = (p: StoredPlaylist) => ({ ...p, items: p.items.filter(sees) });
      const check = (): Response | null => {
        if (typeof body.name !== "string" || body.name.trim() === "") return validation("name");
        const interval = Number(body.intervalSeconds);
        if (!(interval >= 10 && interval <= 86400)) return validation("intervalSeconds");
        const items = (body.items ?? []) as StoredPlaylist["items"];
        if (!items.every(sees)) return validation("items");
        return null;
      };
      if (parts.length === 1 && method === "GET") {
        return json(200, { items: state.playlists.map(view), nextCursor: null });
      }
      if (parts.length === 1 && method === "POST") {
        const extra = unknownField(body, ["name", "intervalSeconds", "items"]);
        if (extra !== undefined) return validation(extra);
        const refused = check();
        if (refused !== null) return refused;
        const playlist: StoredPlaylist = {
          id: `playlist-${nextId++}`,
          name: (body.name as string).trim(),
          intervalSeconds: Number(body.intervalSeconds),
          items: (body.items ?? []) as StoredPlaylist["items"],
          version: 1,
        };
        state.playlists.push(playlist);
        return json(201, view(playlist));
      }
      const playlist = state.playlists.find((p) => p.id === decodeURIComponent(parts[1] ?? ""));
      if (playlist === undefined) return error(404, "not_found");
      if (parts.length === 2 && method === "GET") return json(200, view(playlist));
      if (parts[2] === "play" && method === "GET") {
        const items: { id: string; title: string }[] = [];
        for (const item of playlist.items) {
          const found =
            item.type === "dashboard"
              ? [item.dashboardId]
              : dashboards.dashboards
                  .filter((d) =>
                    (latest(d).model.tags ?? []).some(
                      (t) => t.toLowerCase() === item.tag.toLowerCase(),
                    ),
                  )
                  .sort((a, b) => latest(a).model.title.localeCompare(latest(b).model.title))
                  .map((d) => d.id);
          for (const id of found) {
            const d = visibleDashboard(id);
            if (d !== undefined && d.deletedAt === null && !items.some((i) => i.id === id)) {
              items.push({ id, title: latest(d).model.title });
            }
          }
        }
        return json(200, { intervalSeconds: playlist.intervalSeconds, items });
      }
      if (parts.length === 2 && method === "PUT") {
        const extra = unknownField(body, ["version", "name", "intervalSeconds", "items"]);
        if (extra !== undefined) return validation(extra);
        const refused = check();
        if (refused !== null) return refused;
        if (body.version !== playlist.version) {
          return json(409, {
            error: { code: "version_conflict", message: "a newer version exists" },
            current: view(playlist),
          });
        }
        const keptHidden = playlist.items.filter((i) => !sees(i));
        playlist.name = (body.name as string).trim();
        playlist.intervalSeconds = Number(body.intervalSeconds);
        playlist.items = [...((body.items ?? []) as StoredPlaylist["items"]), ...keptHidden];
        playlist.version++;
        return json(200, view(playlist));
      }
      if (parts.length === 2 && method === "DELETE") {
        state.playlists = state.playlists.filter((p) => p !== playlist);
        return new Response(null, { status: 204 });
      }
      return undefined;
    }

    if (parts[0] === "library-panels") {
      const uses = (id: string) =>
        dashboards.dashboards.filter((d) =>
          latest(d).model.panels.some((p) => p.libraryPanelId === id),
        );
      const writeIn = (folderId: string | null) =>
        can("dashboards:write") ||
        (folderId !== null && dashboards.grants[folderId]?.write === true);
      const view = (p: StoredLibraryPanel) => ({
        ...p,
        uses: uses(p.id).length,
        access: { write: writeIn(p.folderId), delete: can("dashboards:delete") },
      });
      const contentProblem = (model: unknown): Response | null => {
        if (typeof model !== "object" || model === null) return validation("model");
        const m = model as Record<string, unknown>;
        for (const place of ["id", "grid", "rowId", "repeat", "libraryPanelId"]) {
          if (place in m) return validation("model", `model.${place}: not allowed`);
        }
        if (typeof m.type !== "string" || m.type === "") return validation("model", "model.type");
        return null;
      };
      if (parts.length === 1 && method === "GET") {
        if (!can("dashboards:read")) return error(403, "forbidden");
        const q = (search.get("q") ?? "").toLowerCase();
        const items = state.libraryPanels
          .filter((p) => !hidden(p.folderId, can) && p.name.toLowerCase().includes(q))
          .map(view);
        return json(200, { items, nextCursor: null });
      }
      if (parts.length === 1 && method === "POST") {
        const extra = unknownField(body, ["name", "folderId", "model"]);
        if (extra !== undefined) return validation(extra);
        const folderId = (body.folderId as string | null | undefined) ?? null;
        if (!writeIn(folderId)) return error(403, "forbidden");
        if (typeof body.name !== "string" || body.name.trim() === "") return validation("name");
        const refused = contentProblem(body.model);
        if (refused !== null) return refused;
        const created: StoredLibraryPanel = {
          id: `lib-${nextId++}`,
          folderId,
          name: body.name.trim(),
          model: body.model as Record<string, unknown>,
          version: 1,
        };
        state.libraryPanels.push(created);
        return json(201, view(created));
      }
      const panel = state.libraryPanels.find((p) => p.id === decodeURIComponent(parts[1] ?? ""));
      if (panel === undefined || hidden(panel.folderId, can)) return error(404, "not_found");
      if (parts.length === 2 && method === "GET") return json(200, view(panel));
      if (parts[2] === "uses" && method === "GET") {
        const items = uses(panel.id).map((d) => ({
          id: d.id,
          title: latest(d).model.title,
          deletedAt: d.deletedAt,
        }));
        return json(200, { items, hidden: 0 });
      }
      if (parts.length === 2 && method === "PUT") {
        const extra = unknownField(body, ["version", "name", "model", "folderId"]);
        if (extra !== undefined) return validation(extra);
        if (!writeIn(panel.folderId)) return error(403, "forbidden");
        const refused = contentProblem(body.model);
        if (refused !== null) return refused;
        if (body.version !== panel.version) {
          return json(409, {
            error: { code: "version_conflict", message: "a newer version exists" },
            current: view(panel),
          });
        }
        panel.name = String(body.name);
        panel.model = body.model as Record<string, unknown>;
        panel.version++;
        return json(200, view(panel));
      }
      if (parts.length === 2 && method === "DELETE") {
        if (!can("dashboards:delete")) return error(403, "forbidden");
        if (uses(panel.id).length > 0) return error(409, "conflict");
        state.libraryPanels = state.libraryPanels.filter((p) => p !== panel);
        return new Response(null, { status: 204 });
      }
      return undefined;
    }
    return undefined;
  }

  return { state, handle };
}
