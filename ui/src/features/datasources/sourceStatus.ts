import { type QueryClient, type QueryState, queryOptions } from "@tanstack/react-query";
import { isApiError } from "../../api/client";
import { checkHealth, type DatasourceAccess, type DatasourceSummary, type Health } from "./api";
import { kindFamily } from "./kindMarks";

/**
 * What the list knows about a source's connection. The server has no stored status: it is the
 * result of the last connection test run in this session, on request. `unreachable` is the
 * source's own answer (the server reached out and failed); `forbidden` and `failed` are the test
 * request itself refused or lost on the way, which says nothing about the source.
 */
export type SourceStatus =
  | "untested"
  | "testing"
  | "connected"
  | "slow"
  | "unreachable"
  | "forbidden"
  | "failed";

/** A test that answers but takes longer than this counts as slow. */
export const SLOW_MS = 500;

/** A result older than this no longer stands for the source: it counts as untested again. */
export const HEALTH_TTL_MS = 10 * 60_000;

/** The last test of one source: its answer or the error of the request, and whether one runs. */
export interface HealthEntry {
  health: Health | undefined;
  error: Error | null;
  pending: boolean;
  /** When the answer or the error came, in ms since the epoch; 0 while the first test runs. */
  at: number;
}

export const HEALTH_KEY = "datasource-health";

/** The entry of one cached test, or undefined when it never ran. */
export function healthEntry(
  state: Pick<
    QueryState<Health, Error>,
    "data" | "error" | "fetchStatus" | "dataUpdatedAt" | "errorUpdatedAt"
  >,
): HealthEntry | undefined {
  if (state.data === undefined && state.error === null && state.fetchStatus !== "fetching") {
    return undefined;
  }
  return {
    health: state.data,
    error: state.error,
    pending: state.fetchStatus === "fetching",
    at: state.error === null ? state.dataUpdatedAt : state.errorUpdatedAt,
  };
}

/** Drops a source's test result: after a change, a deletion or a restore it no longer applies. */
export function forgetHealth(queryClient: QueryClient, orgId: string, id: string) {
  queryClient.removeQueries({ queryKey: [HEALTH_KEY, orgId, id], exact: true });
}

/** The sources a test may run on: those the caller may query. */
export function testableIds(
  items: readonly DatasourceSummary[],
  accessOf: (source: DatasourceSummary) => DatasourceAccess,
): string[] {
  return items.filter((source) => accessOf(source).query).map((source) => source.id);
}

/**
 * One source's test as a cached query that never runs by itself (`enabled: false`): the rows and
 * the side panel read the same entry, and a test started anywhere shows everywhere. Kept apart
 * from the list's key, so refreshing the list keeps the results.
 */
export function healthQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: [HEALTH_KEY, orgId, id] as const,
    queryFn: () => checkHealth(orgId, id),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

/** Runs the test now, even when an answer is cached; errors stay in the query's state. */
export async function runHealthCheck(queryClient: QueryClient, orgId: string, id: string) {
  try {
    await queryClient.fetchQuery({ ...healthQuery(orgId, id), staleTime: 0 });
  } catch {
    // Shown from the query's error state.
  }
}

/**
 * Tests several sources, a few at a time, so a long list does not open every connection at once.
 * Once `signal` aborts (the page was left), no further test starts; running ones finish.
 */
export async function runHealthChecks(
  queryClient: Pick<QueryClient, "fetchQuery">,
  orgId: string,
  ids: readonly string[],
  { parallel = 4, signal }: { parallel?: number; signal?: AbortSignal } = {},
) {
  let next = 0;
  async function worker() {
    while (next < ids.length && signal?.aborted !== true) {
      const id = ids[next];
      next += 1;
      if (id !== undefined) {
        await runHealthCheck(queryClient as QueryClient, orgId, id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, worker));
}

export function statusOf(entry: HealthEntry | undefined, now = Date.now()): SourceStatus {
  if (entry === undefined) {
    return "untested";
  }
  if (entry.pending) {
    return "testing";
  }
  if (now - entry.at > HEALTH_TTL_MS) {
    return "untested";
  }
  if (entry.error !== null) {
    return isApiError(entry.error, "forbidden") ? "forbidden" : "failed";
  }
  if (entry.health === undefined) {
    return "untested";
  }
  if (!entry.health.ok) {
    return "unreachable";
  }
  return entry.health.latencyMs >= SLOW_MS ? "slow" : "connected";
}

/** The groups of kinds the list filters by, in the order of the filter. */
export const KIND_GROUPS = [
  "tables",
  "metrics",
  "documents",
  "graphs",
  "apis",
  "files",
  "other",
] as const;
export type KindGroup = (typeof KIND_GROUPS)[number];

export function kindGroup(kind: string): KindGroup {
  switch (kindFamily(kind)) {
    case "sql":
    case "sqlFile":
      return "tables";
    case "metrics":
      return "metrics";
    case "documents":
    case "search":
      return "documents";
    case "graph":
      return "graphs";
    case "http":
      return "apis";
    case "file":
      return "files";
    default:
      return "other";
  }
}

export const STATUS_FILTERS = ["connected", "slow", "unreachable", "failed", "untested"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SORTS = ["name", "status", "added"] as const;
export type Sort = (typeof SORTS)[number];

export interface ListFilter {
  search: string;
  group: KindGroup | "all";
  status: StatusFilter | "all";
  sort: Sort;
}

export const NO_FILTER: ListFilter = { search: "", group: "all", status: "all", sort: "name" };

export function isFiltered(filter: ListFilter): boolean {
  return filter.search.trim() !== "" || filter.group !== "all" || filter.status !== "all";
}

/**
 * A running test counts as untested until it answers; a refused or lost test request is one
 * "test failed" group, whatever the reason.
 */
function filterStatus(status: SourceStatus): StatusFilter {
  if (status === "testing") {
    return "untested";
  }
  return status === "forbidden" ? "failed" : status;
}

/** Problems first when sorting by status: the sources that need a look come to the top. */
const STATUS_ORDER: Record<StatusFilter, number> = {
  unreachable: 0,
  failed: 1,
  slow: 2,
  connected: 3,
  untested: 4,
};

/** Whether the shown rows depend on every source, not only on the loaded pages. */
export function needsAllPages(filter: ListFilter): boolean {
  return isFiltered(filter) || filter.sort !== "name";
}

/**
 * The rows to show: matching the search (name, kind key or kind name, any case) and the filters,
 * sorted. Ties keep the name order, so the list never jumps between equal rows.
 */
export function filterSources(
  items: readonly DatasourceSummary[],
  filter: ListFilter,
  kindName: (kind: string) => string,
  status: (id: string) => SourceStatus,
  locale: string,
): DatasourceSummary[] {
  const needle = filter.search.trim().toLocaleLowerCase(locale);
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const byName = (a: DatasourceSummary, b: DatasourceSummary) => collator.compare(a.name, b.name);
  const rows = items.filter((source) => {
    if (filter.group !== "all" && kindGroup(source.kind) !== filter.group) {
      return false;
    }
    if (filter.status !== "all" && filterStatus(status(source.id)) !== filter.status) {
      return false;
    }
    if (needle === "") {
      return true;
    }
    return [source.name, source.kind, kindName(source.kind)].some((text) =>
      text.toLocaleLowerCase(locale).includes(needle),
    );
  });
  if (filter.sort === "added") {
    return rows.sort((a, b) => b.createdAt - a.createdAt || byName(a, b));
  }
  if (filter.sort === "status") {
    return rows.sort(
      (a, b) =>
        STATUS_ORDER[filterStatus(status(a.id))] - STATUS_ORDER[filterStatus(status(b.id))] ||
        byName(a, b),
    );
  }
  return rows.sort(byName);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}
