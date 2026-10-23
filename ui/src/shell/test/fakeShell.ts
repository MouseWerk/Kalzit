import { latest } from "../../features/dashboards/test/fakeDashboards";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../test/fakeServer";
import { fuzzyScore } from "../fuzzy";

/**
 * Fake search, star and recently-viewed routes, written from docs/api/shell.md: only what the
 * caller may open (restricted folders only with `folders:permissions`, dashboards with
 * `dashboards:read`, data sources with `datasources:read` or a grant), nothing in the trash,
 * `Page<T>` answers, unknown query parameters refused.
 */
export interface FakeShellState {
  stars: { dashboardId: string; at: number }[];
  views: { dashboardId: string; at: number }[];
  /** Every search request's query string, to check debouncing and paging. */
  searches: string[];
  now: number;
}

const START = Date.UTC(2026, 9, 20);

export function shellFake(areas: FakeAreaStates): FakeArea<FakeShellState> {
  const state: FakeShellState = { stars: [], views: [], searches: [], now: START };

  function handle(request: FakeRequest): Response | undefined {
    const { method, route, search, permissions } = request;
    const parts = route.split("/").slice(4); // after /api/orgs/{orgId}
    const can = (permission: string) => permissions.has(permission);
    const { folders, dashboards } = areas.dashboards;
    const restricted = (folderId: string | null): boolean => {
      let next = folders.find((f) => f.id === folderId);
      while (next !== undefined) {
        if (next.restricted) return true;
        const parent = next.parentId;
        next = folders.find((f) => f.id === parent);
      }
      return false;
    };
    const visibleFolder = (folderId: string | null) =>
      folderId === null || can("folders:permissions") || !restricted(folderId);
    const path = (folderId: string | null): string[] => {
      const names: string[] = [];
      let next = folders.find((f) => f.id === folderId);
      while (next !== undefined && visibleFolder(next.id)) {
        names.unshift(next.name);
        const parent = next.parentId;
        next = folders.find((f) => f.id === parent);
      }
      return names;
    };
    const readable = (id: string) => {
      const d = dashboards.find((x) => x.id === id);
      return d !== undefined && can("dashboards:read") && visibleFolder(d.folderId) ? d : undefined;
    };
    const entry = (id: string, at: number) => {
      const d = readable(id);
      if (d === undefined || d.deletedAt !== null) return undefined;
      return { id, title: latest(d).model.title, folderId: d.folderId, path: path(d.folderId), at };
    };

    if (parts[0] === "search" && method === "GET") {
      const extra = [...search.keys()].find((k) => !["q", "kind", "limit", "cursor"].includes(k));
      if (extra !== undefined) return error(422, "validation", extra);
      state.searches.push(search.toString());
      const q = search.get("q") ?? "";
      const kind = search.get("kind");
      const hits: Record<string, unknown>[] = [];
      for (const d of dashboards) {
        const title = latest(d).model.title;
        const score = fuzzyScore(q, title);
        if (score !== undefined && d.deletedAt === null && readable(d.id) !== undefined) {
          hits.push({
            kind: "dashboard",
            id: d.id,
            title,
            folderId: d.folderId,
            path: path(d.folderId),
            score,
          });
        }
      }
      for (const f of folders) {
        const score = fuzzyScore(q, f.name);
        if (
          score !== undefined &&
          f.deletedAt === null &&
          can("folders:read") &&
          visibleFolder(f.id)
        ) {
          hits.push({
            kind: "folder",
            id: f.id,
            title: f.name,
            folderId: f.parentId,
            path: path(f.parentId),
            score,
          });
        }
      }
      for (const ds of areas.datasources.datasources) {
        const score = fuzzyScore(q, ds.name);
        const granted = areas.datasources.grants[ds.id] !== undefined;
        if (
          score !== undefined &&
          ds.deletedAt === undefined &&
          (can("datasources:read") || granted)
        ) {
          hits.push({
            kind: "datasource",
            id: ds.id,
            title: ds.name,
            folderId: null,
            path: [],
            datasourceKind: ds.kind,
            score,
          });
        }
      }
      const filtered = hits
        .filter((hit) => kind === null || hit.kind === kind)
        .sort((a, b) => (b.score as number) - (a.score as number));
      const limit = Number(search.get("limit") ?? 50);
      const start = Number(search.get("cursor") ?? 0);
      const items = filtered.slice(start, start + limit);
      const next = start + limit < filtered.length ? String(start + limit) : null;
      return json(200, { items, nextCursor: next });
    }
    if (parts[0] === "stars" && method === "GET") {
      const items = state.stars
        .map((s) => entry(s.dashboardId, s.at))
        .filter((e) => e !== undefined)
        .sort((a, b) => a.title.localeCompare(b.title));
      return json(200, { items, nextCursor: null });
    }
    if (parts[0] === "recents" && method === "GET") {
      const items = [...state.views]
        .sort((a, b) => b.at - a.at)
        .map((v) => entry(v.dashboardId, v.at))
        .filter((e) => e !== undefined)
        .slice(0, Number(search.get("limit") ?? 50));
      return json(200, { items, nextCursor: null });
    }
    if (parts[0] === "dashboards" && parts[2] === "star" && parts.length === 3) {
      const id = decodeURIComponent(parts[1] ?? "");
      if (method === "DELETE") {
        state.stars = state.stars.filter((s) => s.dashboardId !== id);
        return new Response(null, { status: 204 });
      }
      const d = readable(id);
      if (d === undefined) return error(404, "not_found");
      if (method === "GET") {
        return json(200, { starred: state.stars.some((s) => s.dashboardId === id) });
      }
      if (method === "PUT") {
        if (d.deletedAt !== null) return error(409, "conflict");
        if (!state.stars.some((s) => s.dashboardId === id)) {
          state.now += 1000;
          state.stars.push({ dashboardId: id, at: state.now });
        }
        return new Response(null, { status: 204 });
      }
    }
    if (parts[0] === "dashboards" && parts[2] === "views" && method === "POST") {
      const id = decodeURIComponent(parts[1] ?? "");
      if (readable(id) === undefined) return error(404, "not_found");
      state.now += 1000;
      state.views = [
        { dashboardId: id, at: state.now },
        ...state.views.filter((v) => v.dashboardId !== id),
      ].slice(0, 50);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }

  return { state, handle };
}
