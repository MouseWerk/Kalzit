import { queryOptions } from "@tanstack/react-query";
import { listAudit, listMembers, MAX_PAGE_SIZE } from "../features/admin/api";
import { DASHBOARDS_KEY } from "../features/dashboards/api";
import { DATASOURCES_KEY } from "../features/datasources/api";
import { fromWall, wallOf } from "../lib/zonedTime";
import { type SearchKind, search } from "./homeApi";

/*
 * Numbers for the start page and the setup checklist, read from the APIs that exist (no count
 * route): the search for what the caller sees, the member list and the audit log. Each list is
 * read page by page up to a cap; past it, the number shows as "at least".
 */

/** Pages read per count; 5 pages of 200 is 1000 entries, more than a start page needs to say. */
const COUNT_PAGES = 5;

export interface Count {
  value: number;
  /** True when there are more than `value` (the cap was reached). */
  more: boolean;
}

async function countPages(
  page: (cursor: string | undefined) => Promise<{ items: unknown[]; nextCursor: string | null }>,
): Promise<Count> {
  let value = 0;
  let cursor: string | undefined;
  for (let index = 0; index < COUNT_PAGES; index++) {
    const next = await page(cursor);
    value += next.items.length;
    if (next.nextCursor === null) {
      return { value, more: false };
    }
    cursor = next.nextCursor;
  }
  return { value, more: true };
}

function countSearch(orgId: string, kind: SearchKind, signal: AbortSignal): Promise<Count> {
  return countPages((cursor) =>
    search(orgId, { q: "", kind, limit: MAX_PAGE_SIZE, cursor }, signal),
  );
}

/*
 * The keys sit under the area's own prefix, so the area's changes (a dashboard created, a data
 * source deleted, a member added) refresh the numbers as well.
 */

/** Dashboards the caller may open. */
export function dashboardCountQuery(orgId: string) {
  return queryOptions({
    queryKey: [DASHBOARDS_KEY, orgId, "count"],
    queryFn: ({ signal }) => countSearch(orgId, "dashboard", signal),
  });
}

/** Data sources the caller may read. */
export function datasourceCountQuery(orgId: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, "count"],
    queryFn: ({ signal }) => countSearch(orgId, "datasource", signal),
  });
}

/** Members of the organization; needs `users:read`. */
export function memberCountQuery(orgId: string) {
  return queryOptions({
    queryKey: ["admin", "org", orgId, "members", "count"],
    queryFn: () => countPages((cursor) => listMembers(orgId, cursor, MAX_PAGE_SIZE)),
  });
}

export const ACTIVITY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Activity {
  total: Count;
  /** Changes per day, oldest first, the last entry today. */
  perDay: number[];
}

/** Midnight of the day `at` falls in, in the user's time zone. */
function startOfDay(at: number): number {
  return fromWall({ ...wallOf(at), hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/** Days between two midnights, robust against daylight saving shifts (23 or 25 hours). */
function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / DAY_MS);
}

/**
 * Changes recorded in the organization's audit log over the last days, counted per day in the
 * user's time zone; needs `audit:read`.
 */
export async function fetchActivity(orgId: string, now = Date.now()): Promise<Activity> {
  const today = startOfDay(now);
  // Noon of the first day, so a daylight saving shift cannot land on the day before.
  const first = startOfDay(today - (ACTIVITY_DAYS - 1) * DAY_MS + DAY_MS / 2);
  const perDay = Array.from({ length: ACTIVITY_DAYS }, () => 0);
  const total = await countPages(async (cursor) => {
    const page = await listAudit(orgId, { from: first }, cursor);
    for (const event of page.items) {
      const index = daysBetween(first, startOfDay(event.createdAt));
      if (index >= 0 && index < ACTIVITY_DAYS) {
        perDay[index] = (perDay[index] ?? 0) + 1;
      }
    }
    return page;
  });
  return { total, perDay };
}

export function activityQuery(orgId: string) {
  return queryOptions({
    queryKey: ["admin", "audit", orgId, "activity"],
    queryFn: () => fetchActivity(orgId),
  });
}
