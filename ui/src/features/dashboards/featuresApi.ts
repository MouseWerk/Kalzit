import { ApiError, expectShape, isRecord } from "../../api/client";
import type { Page, QueryResponse, TimeRange } from "../../api/generated/shapes";
import { orgPath, send } from "../datasources/api";
import { parseLibraryContent } from "./api";
import {
  type DashboardModel,
  type PanelModel,
  parseModel,
  SCHEMA_VERSION,
  type VariableValues,
} from "./model";

/*
 * Annotations, playlists, library panels and the model check, as docs/api/dashboard-features.md
 * specifies them. Bodies carry exactly the documented fields.
 */

function invalid(what: string): never {
  throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function page<T>(value: unknown, item: (v: unknown) => T | null, what: string): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid(what);
  }
  return {
    items: value.items.map(item).filter((v): v is T => v !== null),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

// Annotations

export interface Annotation {
  id: string;
  panelId: string | null;
  time: number;
  timeEnd: number | null;
  text: string;
  tags: string[];
  version: number;
}

export function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.time !== "number") {
    return null;
  }
  return {
    id: value.id,
    panelId: typeof value.panelId === "string" ? value.panelId : null,
    time: value.time,
    timeEnd: typeof value.timeEnd === "number" ? value.timeEnd : null,
    text: str(value.text),
    tags: strings(value.tags),
    version: num(value.version),
  };
}

/** Pages read at most for one range; a chart this full has no room for more marks anyway. */
const MAX_ANNOTATION_PAGES = 5;

/** The annotations overlapping a range, oldest first. */
export async function fetchAnnotations(
  orgId: string,
  dashboardId: string,
  range: TimeRange,
  signal?: AbortSignal,
): Promise<Annotation[]> {
  const out: Annotation[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_ANNOTATION_PAGES; i++) {
    const params = new URLSearchParams({
      from: String(range.from),
      to: String(range.to),
      limit: "200",
    });
    if (cursor !== null) params.set("cursor", cursor);
    const path = `${orgPath(orgId, "dashboards", dashboardId, "annotations")}?${params}`;
    const answer: Page<Annotation> = page(
      await send("GET", path, undefined, signal),
      parseAnnotation,
      "annotations",
    );
    out.push(...answer.items);
    cursor = answer.nextCursor;
    if (cursor === null) break;
  }
  return out;
}

export interface AnnotationInput {
  time: number;
  timeEnd: number | null;
  text: string;
  tags: string[];
}

export async function createAnnotation(
  orgId: string,
  dashboardId: string,
  input: AnnotationInput & { panelId: string | null },
): Promise<void> {
  const body: Record<string, unknown> = { time: input.time, text: input.text, tags: input.tags };
  if (input.timeEnd !== null) body.timeEnd = input.timeEnd;
  if (input.panelId !== null) body.panelId = input.panelId;
  await send("POST", orgPath(orgId, "dashboards", dashboardId, "annotations"), body);
}

export async function updateAnnotation(
  orgId: string,
  dashboardId: string,
  id: string,
  input: { version: number; text: string; tags: string[]; time?: number; timeEnd?: number | null },
): Promise<void> {
  await send("PATCH", orgPath(orgId, "dashboards", dashboardId, "annotations", id), input);
}

export async function deleteAnnotation(
  orgId: string,
  dashboardId: string,
  id: string,
): Promise<void> {
  await send("DELETE", orgPath(orgId, "dashboards", dashboardId, "annotations", id));
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

/** Runs one stored annotation query of the saved dashboard. */
export async function runAnnotationQuery(
  orgId: string,
  dashboardId: string,
  queryId: string,
  body: { timeRange: TimeRange; variables: VariableValues },
  signal?: AbortSignal,
): Promise<QueryResponse> {
  const path = orgPath(orgId, "dashboards", dashboardId, "annotation-queries", queryId, "query");
  return expectShape(await send("POST", path, body, signal), isQueryResponse, "annotation query");
}

// Playlists

export type PlaylistItem =
  | { type: "dashboard"; dashboardId: string }
  | { type: "tag"; tag: string };

export interface Playlist {
  id: string;
  name: string;
  intervalSeconds: number;
  items: PlaylistItem[];
  version: number;
}

function parseItem(value: unknown): PlaylistItem | null {
  if (!isRecord(value)) return null;
  if (value.type === "dashboard" && typeof value.dashboardId === "string") {
    return { type: "dashboard", dashboardId: value.dashboardId };
  }
  if (value.type === "tag" && typeof value.tag === "string") {
    return { type: "tag", tag: value.tag };
  }
  return null;
}

function parsePlaylist(value: unknown): Playlist | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return {
    id: value.id,
    name: str(value.name),
    intervalSeconds: num(value.intervalSeconds),
    items: (Array.isArray(value.items) ? value.items : []).map(parseItem).filter((i) => i !== null),
    version: num(value.version),
  };
}

export async function fetchPlaylists(orgId: string, signal?: AbortSignal): Promise<Playlist[]> {
  return page(
    await send("GET", `${orgPath(orgId, "playlists")}?limit=200`, undefined, signal),
    parsePlaylist,
    "playlists",
  ).items;
}

export async function fetchPlaylist(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<Playlist> {
  return (
    parsePlaylist(await send("GET", orgPath(orgId, "playlists", id), undefined, signal)) ??
    invalid("playlist")
  );
}

export interface PlaylistInput {
  name: string;
  intervalSeconds: number;
  items: PlaylistItem[];
}

export async function createPlaylist(orgId: string, input: PlaylistInput): Promise<Playlist> {
  return (
    parsePlaylist(await send("POST", orgPath(orgId, "playlists"), input)) ?? invalid("playlist")
  );
}

export async function savePlaylist(
  orgId: string,
  id: string,
  input: PlaylistInput & { version: number },
) {
  await send("PUT", orgPath(orgId, "playlists", id), input);
}

export async function deletePlaylist(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "playlists", id));
}

export interface PlayOrder {
  intervalSeconds: number;
  items: { id: string; title: string }[];
}

export async function fetchPlayOrder(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<PlayOrder> {
  const value = await send("GET", orgPath(orgId, "playlists", id, "play"), undefined, signal);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("play order");
  }
  return {
    intervalSeconds: num(value.intervalSeconds),
    items: value.items.flatMap((i) =>
      isRecord(i) && typeof i.id === "string" ? [{ id: i.id, title: str(i.title) }] : [],
    ),
  };
}

// Library panels

export interface LibraryPanel {
  id: string;
  folderId: string | null;
  name: string;
  /** The content as a panel (id "library", a default grid). */
  panel: PanelModel;
  version: number;
  uses: number;
  access: { write: boolean; delete: boolean };
}

function parseLibraryPanel(value: unknown): LibraryPanel | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  const access = isRecord(value.access) ? value.access : {};
  return {
    id: value.id,
    folderId: typeof value.folderId === "string" ? value.folderId : null,
    name: str(value.name),
    panel: parseLibraryContent(value.model, value.id),
    version: num(value.version),
    uses: num(value.uses),
    access: { write: access.write === true, delete: access.delete === true },
  };
}

/** A panel's content as a library panel stores it: no place, and the model's version. */
export function libraryContent(panel: PanelModel): Record<string, unknown> {
  const {
    id: _id,
    grid: _grid,
    rowId: _row,
    repeat: _repeat,
    libraryPanelId: _lib,
    ...content
  } = panel;
  return { schemaVersion: SCHEMA_VERSION, ...content };
}

export async function fetchLibraryPanels(
  orgId: string,
  q = "",
  signal?: AbortSignal,
): Promise<LibraryPanel[]> {
  const params = new URLSearchParams({ limit: "200" });
  if (q !== "") params.set("q", q);
  return page(
    await send("GET", `${orgPath(orgId, "library-panels")}?${params}`, undefined, signal),
    parseLibraryPanel,
    "library panels",
  ).items;
}

export async function fetchLibraryPanel(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<LibraryPanel> {
  return (
    parseLibraryPanel(await send("GET", orgPath(orgId, "library-panels", id), undefined, signal)) ??
    invalid("library panel")
  );
}

export async function createLibraryPanel(
  orgId: string,
  input: { name: string; folderId: string | null; panel: PanelModel },
): Promise<LibraryPanel> {
  const body = { name: input.name, folderId: input.folderId, model: libraryContent(input.panel) };
  return (
    parseLibraryPanel(await send("POST", orgPath(orgId, "library-panels"), body)) ??
    invalid("library panel")
  );
}

export async function saveLibraryPanel(
  orgId: string,
  id: string,
  input: { name: string; panel: PanelModel; version: number },
): Promise<LibraryPanel> {
  const body = { version: input.version, name: input.name, model: libraryContent(input.panel) };
  return (
    parseLibraryPanel(await send("PUT", orgPath(orgId, "library-panels", id), body)) ??
    invalid("library panel")
  );
}

export async function deleteLibraryPanel(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "library-panels", id));
}

/** The dashboards showing a library panel that the caller may open; others are not told. */
export interface LibraryUses {
  items: { id: string; title: string }[];
}

export async function fetchLibraryUses(
  orgId: string,
  id: string,
  signal?: AbortSignal,
): Promise<LibraryUses> {
  const value = await send("GET", orgPath(orgId, "library-panels", id, "uses"), undefined, signal);
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return invalid("library panel uses");
  }
  return {
    items: value.items.flatMap((i) =>
      isRecord(i) && typeof i.id === "string" ? [{ id: i.id, title: str(i.title) }] : [],
    ),
  };
}

// The model check

/** Checks a model on the server without saving it; answers it as it would be stored. */
export async function validateModel(orgId: string, model: unknown): Promise<DashboardModel> {
  const value = await send("POST", orgPath(orgId, "dashboards", "validate"), { model });
  if (!isRecord(value) || !isRecord(value.model)) {
    return invalid("model check");
  }
  return parseModel(value.model, "");
}

export const ANNOTATIONS_KEY = "annotations";
export const PLAYLISTS_KEY = "playlists";
export const LIBRARY_PANELS_KEY = "library-panels";
