/**
 * Usage insights (docs/api/usage.md): counts per dashboard, panel and data source, never per
 * person. An organization's report for members with `audit:read`; server administrators read
 * every organization's, or one's, through the server routes. Responses are checked, so a
 * mismatch fails as `invalid_response`.
 */
import { expectShape, isRecord, request } from "../../api/client";

export interface UsageTotals {
  views: number;
  panelRuns: number;
  panelErrors: number;
  queries: number;
  queryErrors: number;
  cacheHits: number;
  cacheMisses: number;
}

export interface UsageTrendPoint {
  at: number;
  views: number;
  panelRuns: number;
  panelErrors: number;
  queries: number;
  queryErrors: number;
}

export interface DashboardUsage {
  orgId: string;
  orgName: string;
  id: string;
  title: string;
  views: number;
  lastViewedAt: number;
}

export interface PanelUsage {
  orgId: string;
  orgName: string;
  dashboardId: string;
  dashboardTitle: string;
  panelId: string;
  panelTitle: string;
  runs: number;
  errors: number;
  cacheHits: number;
  cacheMisses: number;
  rows: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
}

export interface SourceUsage {
  orgId: string;
  orgName: string;
  id: string;
  name: string;
  kind: string;
  queries: number;
  errors: number;
  errorsTimeout: number;
  errorsRejected: number;
  errorsSource: number;
  errorsOther: number;
  cacheHits: number;
  cacheMisses: number;
  rows: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
}

export interface UsageReport {
  from: number;
  to: number;
  stepMs: number;
  recording: boolean;
  retentionDays: number;
  since: number | null;
  dropped: number;
  totals: UsageTotals;
  trend: UsageTrendPoint[];
  dashboards: DashboardUsage[];
  slowPanels: PanelUsage[];
  failingPanels: PanelUsage[];
  sources: SourceUsage[];
}

export interface UnusedDashboard {
  orgId: string;
  orgName: string;
  id: string;
  title: string;
  createdAt: number;
  lastViewedAt: number | null;
}

export interface UnusedDashboards {
  days: number;
  since: number;
  recordedSince: number | null;
  items: UnusedDashboard[];
  total: number;
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const arrayOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);

function shape<T>(fields: Record<keyof T, Check>): (value: unknown) => value is T {
  return (value): value is T =>
    isRecord(value) && Object.entries<Check>(fields).every(([name, check]) => check(value[name]));
}

const isTotals = shape<UsageTotals>({
  views: isNumber,
  panelRuns: isNumber,
  panelErrors: isNumber,
  queries: isNumber,
  queryErrors: isNumber,
  cacheHits: isNumber,
  cacheMisses: isNumber,
});

const isTrendPoint = shape<UsageTrendPoint>({
  at: isNumber,
  views: isNumber,
  panelRuns: isNumber,
  panelErrors: isNumber,
  queries: isNumber,
  queryErrors: isNumber,
});

const isDashboard = shape<DashboardUsage>({
  orgId: isString,
  orgName: isString,
  id: isString,
  title: isString,
  views: isNumber,
  lastViewedAt: isNumber,
});

const isPanel = shape<PanelUsage>({
  orgId: isString,
  orgName: isString,
  dashboardId: isString,
  dashboardTitle: isString,
  panelId: isString,
  panelTitle: isString,
  runs: isNumber,
  errors: isNumber,
  cacheHits: isNumber,
  cacheMisses: isNumber,
  rows: isNumber,
  p50Ms: nullable(isNumber),
  p95Ms: nullable(isNumber),
  maxMs: isNumber,
});

const isSource = shape<SourceUsage>({
  orgId: isString,
  orgName: isString,
  id: isString,
  name: isString,
  kind: isString,
  queries: isNumber,
  errors: isNumber,
  errorsTimeout: isNumber,
  errorsRejected: isNumber,
  errorsSource: isNumber,
  errorsOther: isNumber,
  cacheHits: isNumber,
  cacheMisses: isNumber,
  rows: isNumber,
  p50Ms: nullable(isNumber),
  p95Ms: nullable(isNumber),
  maxMs: isNumber,
});

const isReport = shape<UsageReport>({
  from: isNumber,
  to: isNumber,
  stepMs: isNumber,
  recording: isBoolean,
  retentionDays: isNumber,
  since: nullable(isNumber),
  dropped: isNumber,
  totals: isTotals,
  trend: arrayOf(isTrendPoint),
  dashboards: arrayOf(isDashboard),
  slowPanels: arrayOf(isPanel),
  failingPanels: arrayOf(isPanel),
  sources: arrayOf(isSource),
});

const isUnusedDashboard = shape<UnusedDashboard>({
  orgId: isString,
  orgName: isString,
  id: isString,
  title: isString,
  createdAt: isNumber,
  lastViewedAt: nullable(isNumber),
});

const isUnused = shape<UnusedDashboards>({
  days: isNumber,
  since: isNumber,
  recordedSince: nullable(isNumber),
  items: arrayOf(isUnusedDashboard),
  total: isNumber,
});

/**
 * Whose usage: a member's organization (`org`), or for server administrators one organization or
 * every one (`server`, `orgId` undefined).
 */
export type UsageScope = { kind: "org"; orgId: string } | { kind: "server"; orgId?: string };

function scopePath(scope: UsageScope, rest: string, params: URLSearchParams): string {
  if (scope.kind === "server" && scope.orgId !== undefined) {
    params.set("orgId", scope.orgId);
  }
  const base =
    scope.kind === "org"
      ? `/api/orgs/${encodeURIComponent(scope.orgId)}/usage`
      : "/api/admin/usage";
  return `${base}${rest}?${params.toString()}`;
}

export async function fetchUsage(
  scope: UsageScope,
  range: { from: number; to: number },
  signal?: AbortSignal,
): Promise<UsageReport> {
  const params = new URLSearchParams({ from: String(range.from), to: String(range.to) });
  const value = await request("GET", scopePath(scope, "", params), undefined, { signal });
  return expectShape(value, isReport, "usage");
}

export async function fetchUnused(
  scope: UsageScope,
  days: number,
  signal?: AbortSignal,
): Promise<UnusedDashboards> {
  const params = new URLSearchParams({ days: String(days) });
  const value = await request("GET", scopePath(scope, "/unused", params), undefined, { signal });
  return expectShape(value, isUnused, "unused dashboards");
}

export const usageKeys = {
  all: ["usage"] as const,
  report: (scope: UsageScope, days: number) =>
    ["usage", "report", scope.kind, scope.orgId ?? "all", days] as const,
  unused: (scope: UsageScope, days: number) =>
    ["usage", "unused", scope.kind, scope.orgId ?? "all", days] as const,
};

/** The share of answers from the cache, 0 to 1; null without cache use. */
export function hitRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  return total === 0 ? null : hits / total;
}

/** The share of failing runs, 0 to 1; null without runs. */
export function errorRate(errors: number, runs: number): number | null {
  return runs === 0 ? null : errors / runs;
}
