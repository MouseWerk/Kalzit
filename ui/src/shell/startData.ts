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

/** The numbers change rarely; a visit to the start page within a minute reads none again. */
const COUNT_STALE_MS = 60_000;

export interface Count {
  value: number;
  /** True when there are more than `value` (the cap was reached). */
  more: boolean;
}

interface PageOf<T> {
  items: T[];
  nextCursor: string | null;
}

/** Reads pages until the end or the cap; `onPage` sees each page's items. */
async function readPages<T>(
  page: (cursor: string | undefined) => Promise<PageOf<T>>,
  onPage: (items: T[]) => number = (items) => items.length,
): Promise<Count & { last: T | undefined }> {
  let value = 0;
  let cursor: string | undefined;
  let last: T | undefined;
  for (let index = 0; index < COUNT_PAGES; index++) {
    const next = await page(cursor);
    value += onPage(next.items);
    last = next.items.at(-1) ?? last;
    if (next.nextCursor === null) {
      return { value, more: false, last };
    }
    cursor = next.nextCursor;
  }
  return { value, more: true, last };
}

async function countPages<T>(
  page: (cursor: string | undefined) => Promise<PageOf<T>>,
): Promise<Count> {
  const { value, more } = await readPages(page);
  return { value, more };
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
    staleTime: COUNT_STALE_MS,
  });
}

/** Data sources the caller may read. */
export function datasourceCountQuery(orgId: string) {
  return queryOptions({
    queryKey: [DATASOURCES_KEY, orgId, "count"],
    queryFn: ({ signal }) => countSearch(orgId, "datasource", signal),
    staleTime: COUNT_STALE_MS,
  });
}

/** Members of the organization; needs `users:read`. */
export function memberCountQuery(orgId: string) {
  return queryOptions({
    queryKey: ["admin", "org", orgId, "members", "count"],
    queryFn: ({ signal }) =>
      countPages((cursor) => listMembers(orgId, cursor, MAX_PAGE_SIZE, signal)),
    staleTime: COUNT_STALE_MS,
  });
}

/*
 * Whether there is anything at all, for the setup checklist: one entry is enough to know (two
 * for members, as the creator is the first), so these never page through a list.
 */

export function hasAnyQuery(orgId: string, kind: "dashboard" | "datasource") {
  return queryOptions({
    queryKey: [kind === "dashboard" ? DASHBOARDS_KEY : DATASOURCES_KEY, orgId, "any"],
    queryFn: async ({ signal }) =>
      (await search(orgId, { q: "", kind, limit: 1 }, signal)).items.length > 0,
    staleTime: COUNT_STALE_MS,
  });
}

/** Whether anyone besides the creator is a member; needs `users:read`. */
export function hasColleagueQuery(orgId: string) {
  return queryOptions({
    queryKey: ["admin", "org", orgId, "members", "colleague"],
    queryFn: async ({ signal }) =>
      (await listMembers(orgId, undefined, 2, signal)).items.length > 1,
    staleTime: COUNT_STALE_MS,
  });
}

export const ACTIVITY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Activity {
  total: Count;
  /**
   * Changes per day, oldest first, the last entry today. Null for a day the capped reading did
   * not reach, so it is unknown rather than quiet.
   */
  perDay: (number | null)[];
}

/** Midnight of the day `at` falls in, in the user's time zone. */
function startOfDay(at: number): number {
  return fromWall({ ...wallOf(at), hour: 0, minute: 0, second: 0, millisecond: 0 });
}

/** Days between two midnights, robust against daylight saving shifts (23 or 25 hours). */
function daysBetween(from: number, to: number): number {
  return Math.round((to - from) / DAY_MS);
}

/** Sign-ins and sign-outs are no changes to the organization. */
const isChange = (action: string) => !action.startsWith("auth.");

/**
 * Changes recorded in the organization's audit log over the last days, counted per day in the
 * user's time zone; needs `audit:read`. The log answers newest first.
 */
export async function fetchActivity(
  orgId: string,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<Activity> {
  const today = startOfDay(now);
  // Noon of the first day, so a daylight saving shift cannot land on the day before.
  const first = startOfDay(today - (ACTIVITY_DAYS - 1) * DAY_MS + DAY_MS / 2);
  const perDay: (number | null)[] = Array.from({ length: ACTIVITY_DAYS }, () => 0);
  const read = await readPages(
    (cursor) => listAudit(orgId, { from: first }, cursor, { limit: MAX_PAGE_SIZE, signal }),
    (items) => {
      const changes = items.filter((event) => isChange(event.action));
      for (const event of changes) {
        const index = daysBetween(first, startOfDay(event.createdAt));
        if (index >= 0 && index < ACTIVITY_DAYS) {
          perDay[index] = (perDay[index] ?? 0) + 1;
        }
      }
      return changes.length;
    },
  );
  if (read.more && read.last !== undefined) {
    // The reading stopped inside the oldest day it reached: that day and those before it are
    // not known.
    const reached = daysBetween(first, startOfDay(read.last.createdAt));
    for (let index = 0; index <= Math.min(reached, ACTIVITY_DAYS - 1); index++) {
      perDay[index] = null;
    }
  }
  return { total: { value: read.value, more: read.more }, perDay };
}

export function activityQuery(orgId: string) {
  return queryOptions({
    queryKey: ["admin", "audit", orgId, "activity"],
    queryFn: ({ signal }) => fetchActivity(orgId, Date.now(), signal),
    staleTime: COUNT_STALE_MS,
  });
}
