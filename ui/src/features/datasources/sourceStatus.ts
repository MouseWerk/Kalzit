import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { checkHealth, type DatasourceSummary, type Health } from "./api";
import { kindFamily } from "./kindMarks";

/**
 * What the list knows about a source's connection. The server has no stored status: it is the
 * result of the last connection test run in this session, on request.
 */
export type SourceStatus = "untested" | "testing" | "connected" | "slow" | "unreachable";

/** A test that answers but takes longer than this counts as slow. */
export const SLOW_MS = 500;

/** The last test of one source: its answer or the error of the request, and whether one runs. */
export interface HealthEntry {
  health: Health | undefined;
  error: Error | null;
  pending: boolean;
}

export const HEALTH_KEY = "datasource-health";

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

/** Tests several sources, a few at a time, so a long list does not open every connection at once. */
export async function runHealthChecks(
  queryClient: QueryClient,
  orgId: string,
  ids: readonly string[],
  parallel = 4,
) {
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      if (id !== undefined) {
        await runHealthCheck(queryClient, orgId, id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, ids.length) }, worker));
}

export function statusOf(entry: HealthEntry | undefined): SourceStatus {
  if (entry === undefined) {
    return "untested";
  }
  if (entry.pending) {
    return "testing";
  }
  if (entry.error !== null) {
    return "unreachable";
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

export const STATUS_FILTERS = ["connected", "slow", "unreachable", "untested"] as const;
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

/** A running test counts as untested until it answers. */
function filterStatus(status: SourceStatus): StatusFilter {
  return status === "testing" ? "untested" : status;
}

/** Problems first when sorting by status: the sources that need a look come to the top. */
const STATUS_ORDER: Record<StatusFilter, number> = {
  unreachable: 0,
  slow: 1,
  connected: 2,
  untested: 3,
};

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
