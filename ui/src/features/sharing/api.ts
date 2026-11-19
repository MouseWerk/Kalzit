import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord, request } from "../../api/client";
import type {
  CreatedPublicLink,
  CreatedSnapshot,
  CreatePublicLink,
  CreateSnapshot,
  PublicDashboard,
  PublicLink,
  PublicSnapshotView,
  QueryResponse,
  SharedTimeRange,
  SnapshotSummary,
  SnapshotView,
  TimeRange,
} from "../../api/generated/shapes";

/*
 * Public links and snapshots of dashboards (docs/api/sharing.md). The organization routes need a
 * session; the routes under `/api/public` are for visitors and answer one neutral refusal.
 */

export const SHARING_KEY = "sharing";

const enc = encodeURIComponent;

function orgPath(orgId: string, rest: string): string {
  return `/api/orgs/${enc(orgId)}${rest}`;
}

const SHARE_STATUSES = ["active", "suspended", "expired", "revoked"];

function isPublicLink(value: unknown): value is PublicLink {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.dashboardId === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    typeof value.maxWindowMs === "number" &&
    isRecord(value.timeRange) &&
    typeof value.views === "number" &&
    typeof value.status === "string" &&
    SHARE_STATUSES.includes(value.status)
  );
}

function isSnapshot(value: unknown): value is SnapshotSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.dashboardId === "string" &&
    typeof value.title === "string" &&
    typeof value.public === "boolean" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    isRecord(value.timeRange) &&
    typeof value.sizeBytes === "number" &&
    typeof value.views === "number"
  );
}

function isPublicDashboard(value: unknown): value is PublicDashboard {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    Array.isArray(value.variables) &&
    Array.isArray(value.rows) &&
    Array.isArray(value.panels)
  );
}

function isQueryResponse(value: unknown): value is QueryResponse {
  return isRecord(value) && isRecord(value.results);
}

function itemsOf<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  const page = expectShape(value, isRecord, what);
  const items = Array.isArray(page.items) ? page.items : [];
  return items.map((item) => expectShape(item, guard, what));
}

export interface ShareFilter {
  /** Only the caller's own; organization admins see everyone's without it. */
  mine?: boolean;
  dashboardId?: string;
}

function filterQuery(filter: ShareFilter, cursor: string | null): string {
  const search = new URLSearchParams();
  if (filter.mine === true) search.set("mine", "true");
  if (filter.dashboardId !== undefined) search.set("dashboardId", filter.dashboardId);
  search.set("limit", "200");
  if (cursor !== null) search.set("cursor", cursor);
  return `?${search.toString()}`;
}

/** The most pages a list reads: 2000 entries, far above what an organization keeps for 30 days. */
const MAX_PAGES = 10;

async function allPages<T>(
  path: (cursor: string | null) => string,
  guard: (item: unknown) => item is T,
  what: string,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await request("GET", path(cursor), undefined, { signal });
    out.push(...itemsOf(answer, guard, what));
    const next: unknown = isRecord(answer) ? answer.nextCursor : null;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  return out;
}

export function listPublicLinks(orgId: string, filter: ShareFilter = {}, signal?: AbortSignal) {
  return allPages(
    (cursor) => orgPath(orgId, `/public-links${filterQuery(filter, cursor)}`),
    isPublicLink,
    "public links",
    signal,
  );
}

export function listSnapshots(orgId: string, filter: ShareFilter = {}, signal?: AbortSignal) {
  return allPages(
    (cursor) => orgPath(orgId, `/snapshots${filterQuery(filter, cursor)}`),
    isSnapshot,
    "snapshots",
    signal,
  );
}

/** A public link or a snapshot, as the lists show them side by side. */
export type Share =
  | { kind: "link"; orgId: string; link: PublicLink }
  | { kind: "snapshot"; orgId: string; snapshot: SnapshotSummary };

async function listShares(orgId: string, filter: ShareFilter, signal?: AbortSignal) {
  const [links, snapshots] = await Promise.all([
    listPublicLinks(orgId, filter, signal),
    listSnapshots(orgId, filter, signal),
  ]);
  const shares: Share[] = [
    ...links.map((link): Share => ({ kind: "link", orgId, link })),
    ...snapshots.map((snapshot): Share => ({ kind: "snapshot", orgId, snapshot })),
  ];
  return shares.sort((a, b) => shareOf(b).createdAt - shareOf(a).createdAt);
}

/** The fields both kinds have. */
export function shareOf(share: Share): PublicLink | SnapshotSummary {
  return share.kind === "link" ? share.link : share.snapshot;
}

export function sharesQuery(orgId: string, filter: ShareFilter = {}) {
  return queryOptions({
    queryKey: [SHARING_KEY, orgId, "shares", filter] as const,
    queryFn: ({ signal }) => listShares(orgId, filter, signal),
  });
}

export async function createPublicLink(
  orgId: string,
  dashboardId: string,
  input: CreatePublicLink,
): Promise<CreatedPublicLink> {
  const answer = expectShape(
    await request("POST", orgPath(orgId, `/dashboards/${enc(dashboardId)}/public-links`), input),
    isRecord,
    "public link",
  );
  return {
    link: expectShape(answer.link, isPublicLink, "public link"),
    token: typeof answer.token === "string" ? answer.token : "",
  };
}

export async function createSnapshot(
  orgId: string,
  dashboardId: string,
  input: CreateSnapshot,
): Promise<CreatedSnapshot> {
  const answer = expectShape(
    await request("POST", orgPath(orgId, `/dashboards/${enc(dashboardId)}/snapshots`), input),
    isRecord,
    "snapshot",
  );
  return {
    snapshot: expectShape(answer.snapshot, isSnapshot, "snapshot"),
    ...(typeof answer.token === "string" ? { token: answer.token } : {}),
  };
}

function sharePath(share: Share): string {
  return share.kind === "link"
    ? orgPath(share.orgId, `/public-links/${enc(share.link.id)}`)
    : orgPath(share.orgId, `/snapshots/${enc(share.snapshot.id)}`);
}

export async function changeExpiry(share: Share, expiresAt: number): Promise<void> {
  await request("PATCH", sharePath(share), { expiresAt });
}

/** Final: a revoked link or snapshot never works again. */
export async function revokeShare(share: Share): Promise<void> {
  await request("POST", `${sharePath(share)}/revoke`, {});
}

function parseSnapshotView(value: unknown): SnapshotView {
  const answer = expectShape(value, isRecord, "snapshot");
  return {
    snapshot: expectShape(answer.snapshot, isSnapshot, "snapshot"),
    dashboard: expectShape(answer.dashboard, isPublicDashboard, "snapshot"),
    results: isRecord(answer.results) ? (answer.results as SnapshotView["results"]) : {},
  };
}

export function snapshotQuery(orgId: string, snapshotId: string) {
  return queryOptions({
    queryKey: [SHARING_KEY, orgId, "snapshot", snapshotId] as const,
    queryFn: async ({ signal }) =>
      parseSnapshotView(
        await request("GET", orgPath(orgId, `/snapshots/${enc(snapshotId)}`), undefined, {
          signal,
        }),
      ),
    // Frozen: nothing about it changes, and every read counts as a view.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

// For visitors: no session, one neutral refusal.

/** A public link as its page uses it. */
export interface PublicLinkPage {
  dashboard: PublicDashboard;
  timeRange: SharedTimeRange;
  maxWindowMs: number;
  expiresAt: number;
  /**
   * The server's clock minus the browser's when the answer arrived. The window is counted from
   * the server's clock, so the page adds this to its own; 0 from a server that names no time.
   */
  clockSkewMs: number;
}

export async function fetchPublicLink(token: string, signal?: AbortSignal) {
  const answer = expectShape(
    await request("GET", `/api/public/dashboards/${enc(token)}`, undefined, { signal }),
    isRecord,
    "public link",
  );
  const view: PublicLinkPage = {
    dashboard: expectShape(answer.dashboard, isPublicDashboard, "public link"),
    timeRange: isRecord(answer.timeRange)
      ? { from: String(answer.timeRange.from), to: String(answer.timeRange.to) }
      : { from: "now-24h", to: "now" },
    maxWindowMs: typeof answer.maxWindowMs === "number" ? answer.maxWindowMs : 0,
    expiresAt: typeof answer.expiresAt === "number" ? answer.expiresAt : 0,
    clockSkewMs: typeof answer.now === "number" ? answer.now - Date.now() : 0,
  };
  return view;
}

export async function queryPublicPanel(
  token: string,
  panelId: string,
  timeRange: TimeRange,
  signal?: AbortSignal,
): Promise<QueryResponse> {
  return expectShape(
    await request(
      "POST",
      `/api/public/dashboards/${enc(token)}/panels/${enc(panelId)}/query`,
      { timeRange },
      { signal },
    ),
    isQueryResponse,
    "public panel",
  );
}

export async function fetchPublicSnapshot(
  token: string,
  signal?: AbortSignal,
): Promise<PublicSnapshotView> {
  const answer = expectShape(
    await request("GET", `/api/public/snapshots/${enc(token)}`, undefined, { signal }),
    isRecord,
    "public snapshot",
  );
  const range = isRecord(answer.timeRange) ? answer.timeRange : {};
  return {
    title: typeof answer.title === "string" ? answer.title : "",
    timeRange: { from: Number(range.from), to: Number(range.to) },
    createdAt: typeof answer.createdAt === "number" ? answer.createdAt : 0,
    expiresAt: typeof answer.expiresAt === "number" ? answer.expiresAt : 0,
    dashboard: expectShape(answer.dashboard, isPublicDashboard, "public snapshot"),
    results: isRecord(answer.results) ? (answer.results as PublicSnapshotView["results"]) : {},
  };
}
