import { queryOptions } from "@tanstack/react-query";
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

/** Entries per request; the server keeps at most 500 per user and organization. */
const PAGE = 100;

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

/** The caller's newest entries, following the cursor up to the server's cap. */
export async function fetchHistory(
  orgId: string,
  filter: HistoryFilter,
  signal?: AbortSignal,
): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  let cursor: string | null = null;
  do {
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
    for (const item of page.items ?? []) {
      const entry = parseEntry(item);
      if (entry !== null) {
        entries.push(entry);
      }
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
  } while (cursor !== null);
  return entries;
}

export function historyQuery(orgId: string, filter: HistoryFilter) {
  return queryOptions({
    queryKey: [HISTORY_KEY, orgId, filter.datasourceId, filter.text],
    queryFn: ({ signal }) => fetchHistory(orgId, filter, signal),
    staleTime: 0,
  });
}

export async function deleteHistoryEntry(orgId: string, id: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "explore", "history", id));
}

export async function clearHistory(orgId: string): Promise<void> {
  await send("DELETE", orgPath(orgId, "explore", "history"));
}
