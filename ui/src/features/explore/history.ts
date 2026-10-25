import { infiniteQueryOptions } from "@tanstack/react-query";
import { orgPath, send } from "../datasources/api";

/** One query the caller ran from Explore (docs/api/explore-history.md). */
export interface HistoryEntry {
  id: string;
  datasourceId: string;
  datasourceName: string;
  datasourceKind: string;
  query: unknown;
  shape: string;
  rowCount: number | null;
  durationMs: number | null;
  createdAt: number;
}

export const HISTORY_KEY = "exploreHistory";

function parseEntry(value: unknown): HistoryEntry | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.datasourceId !== "string" ||
    typeof v.datasourceName !== "string" ||
    typeof v.createdAt !== "number"
  ) {
    return null;
  }
  return {
    id: v.id,
    datasourceId: v.datasourceId,
    datasourceName: v.datasourceName,
    datasourceKind: typeof v.datasourceKind === "string" ? v.datasourceKind : "",
    query: v.query,
    shape: typeof v.shape === "string" ? v.shape : "frame",
    rowCount: typeof v.rowCount === "number" ? v.rowCount : null,
    durationMs: typeof v.durationMs === "number" ? v.durationMs : null,
    createdAt: v.createdAt,
  };
}

export interface HistoryFilter {
  datasourceId: string;
  text: string;
}

export interface HistoryPage {
  items: HistoryEntry[];
  nextCursor: string | null;
}

/** Entries per page; "Load more" follows the cursor. */
const PAGE = 50;

/** One page of the caller's entries, newest first. */
export async function fetchHistoryPage(
  orgId: string,
  filter: HistoryFilter,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (filter.datasourceId !== "") {
    params.set("datasourceId", filter.datasourceId);
  }
  if (filter.text !== "") {
    params.set("q", filter.text);
  }
  if (cursor !== null) {
    params.set("cursor", cursor);
  }
  const page = (await send(
    "GET",
    `${orgPath(orgId, "explore", "history")}?${params}`,
    undefined,
    signal,
  )) as { items?: unknown[]; nextCursor?: string | null };
  const items: HistoryEntry[] = [];
  for (const item of page.items ?? []) {
    const entry = parseEntry(item);
    if (entry !== null) {
      items.push(entry);
    }
  }
  return { items, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
}

export function historyQuery(orgId: string, filter: HistoryFilter) {
  return infiniteQueryOptions({
    queryKey: [HISTORY_KEY, orgId, filter.datasourceId, filter.text],
    queryFn: ({ pageParam, signal }) => fetchHistoryPage(orgId, filter, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });
}

export async function deleteHistoryEntry(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "explore", "history", id));
}

export async function clearHistory(orgId: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "explore", "history"));
}
