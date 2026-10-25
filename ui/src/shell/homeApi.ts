import { queryOptions } from "@tanstack/react-query";
import { ApiError, isRecord, request } from "../api/client";
import type { Page } from "../api/generated/shapes";

/*
 * Search, stars and recently viewed dashboards (docs/api/shell.md). Every answer holds only what
 * the caller may open; the server decides it per request.
 */

export type SearchKind = "dashboard" | "folder" | "datasource";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  folderId: string | null;
  /** Folder names from the top down to where the hit lives. */
  path: string[];
  datasourceKind?: string | undefined;
  score: number;
}

/** A starred or recently opened dashboard. */
export interface DashboardEntry {
  id: string;
  title: string;
  folderId: string | null;
  path: string[];
  /** When it was starred, or last opened, in Unix milliseconds. */
  at: number;
}

function orgPath(orgId: string, ...segments: string[]): string {
  return ["/api/orgs", orgId, ...segments]
    .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
    .join("/");
}

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function parseHit(value: unknown): SearchHit | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") {
    return null;
  }
  const kind = value.kind;
  if (kind !== "dashboard" && kind !== "folder" && kind !== "datasource") {
    return null;
  }
  return {
    kind,
    id: value.id,
    title: value.title,
    folderId: typeof value.folderId === "string" ? value.folderId : null,
    path: strings(value.path),
    datasourceKind: typeof value.datasourceKind === "string" ? value.datasourceKind : undefined,
    score: typeof value.score === "number" ? value.score : 0,
  };
}

function parseEntry(value: unknown): DashboardEntry | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    folderId: typeof value.folderId === "string" ? value.folderId : null,
    path: strings(value.path),
    at: typeof value.at === "number" ? value.at : 0,
  };
}

function parsePage<T>(value: unknown, item: (v: unknown) => T | null, what: string): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid(what);
  }
  return {
    items: value.items.map(item).filter((v): v is T => v !== null),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

export async function search(
  orgId: string,
  input: { q: string; cursor?: string | undefined; limit?: number; kind?: SearchKind },
  signal?: AbortSignal,
): Promise<Page<SearchHit>> {
  const params = new URLSearchParams();
  if (input.q.trim() !== "") params.set("q", input.q.trim());
  if (input.kind !== undefined) params.set("kind", input.kind);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  const query = params.toString();
  const path = orgPath(orgId, "search") + (query === "" ? "" : `?${query}`);
  return parsePage(await request("GET", path, undefined, { signal }), parseHit, "search");
}

/** `?team=` for a list in a team context (docs/api/access.md, "Team spaces"). */
function teamParam(team: string | undefined, joiner: "?" | "&"): string {
  return team === undefined ? "" : `${joiner}team=${encodeURIComponent(team)}`;
}

export async function fetchStars(orgId: string, signal?: AbortSignal, team?: string) {
  return parsePage(
    await request("GET", orgPath(orgId, "stars") + teamParam(team, "?"), undefined, { signal }),
    parseEntry,
    "stars",
  );
}

export async function fetchRecents(orgId: string, signal?: AbortSignal, team?: string) {
  const path = `${orgPath(orgId, "recents")}?limit=10${teamParam(team, "&")}`;
  return parsePage(await request("GET", path, undefined, { signal }), parseEntry, "recents");
}

export async function fetchStarred(orgId: string, dashboardId: string, signal?: AbortSignal) {
  const value = await request("GET", orgPath(orgId, "dashboards", dashboardId, "star"), undefined, {
    signal,
  });
  return isRecord(value) && value.starred === true;
}

export async function setStarred(orgId: string, dashboardId: string, starred: boolean) {
  await request(starred ? "PUT" : "DELETE", orgPath(orgId, "dashboards", dashboardId, "star"));
}

/** The caller's pinned dashboards, in their order (at most 10, one page). */
export async function fetchPins(orgId: string, signal?: AbortSignal) {
  return parsePage(
    await request("GET", orgPath(orgId, "pins"), undefined, { signal }),
    parseEntry,
    "pins",
  );
}

export async function setPinned(orgId: string, dashboardId: string, pinned: boolean) {
  await request(pinned ? "PUT" : "DELETE", orgPath(orgId, "dashboards", dashboardId, "pin"));
}

/** Puts the pins in a new order: every pinned dashboard the caller sees, each once. */
export async function orderPins(orgId: string, dashboardIds: readonly string[]) {
  return parsePage(
    await request("PUT", orgPath(orgId, "pins"), { dashboardIds }),
    parseEntry,
    "pins",
  );
}

/** At most this many pins; the server refuses more. */
export const MAX_PINS = 10;

export async function recordView(orgId: string, dashboardId: string) {
  await request("POST", orgPath(orgId, "dashboards", dashboardId, "views"));
}

export const HOME_KEY = "home";

/** The starred dashboards; with `team`, those in that team context. */
export function starsQuery(orgId: string, team?: string) {
  return queryOptions({
    queryKey: [HOME_KEY, orgId, "stars", team ?? null],
    queryFn: ({ signal }) => fetchStars(orgId, signal, team),
  });
}

export function pinsQuery(orgId: string) {
  return queryOptions({
    queryKey: [HOME_KEY, orgId, "pins"],
    queryFn: ({ signal }) => fetchPins(orgId, signal),
  });
}

/** The recently viewed dashboards; with `team`, those in that team context. */
export function recentsQuery(orgId: string, team?: string) {
  return queryOptions({
    queryKey: [HOME_KEY, orgId, "recents", team ?? null],
    queryFn: ({ signal }) => fetchRecents(orgId, signal, team),
  });
}

export function starredQuery(orgId: string, dashboardId: string) {
  return queryOptions({
    queryKey: [HOME_KEY, orgId, "starred", dashboardId],
    queryFn: ({ signal }) => fetchStarred(orgId, dashboardId, signal),
  });
}
