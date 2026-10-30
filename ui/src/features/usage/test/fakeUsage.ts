import type { FakeArea, FakeServer } from "../../../test/fakeServer";
import { error, json } from "../../../test/fakeServer";
import type { UnusedDashboards, UsageReport } from "../api";

/**
 * The usage routes of docs/api/usage.md for tests: an organization's report for members with
 * `audit:read`, the server's for server administrators. Answers the arranged report and unused
 * list; the server computes them in its own tests.
 */
export interface FakeUsageState {
  report: UsageReport;
  unused: UnusedDashboards;
}

const HOUR = 3_600_000;
export const NOW = Date.UTC(2026, 9, 29, 12);

export function sampleReport(): UsageReport {
  return {
    from: NOW - 7 * 24 * HOUR,
    to: NOW,
    stepMs: 24 * HOUR,
    recording: true,
    retentionDays: 90,
    since: null,
    dropped: 0,
    totals: {
      views: 1234,
      panelRuns: 900,
      panelErrors: 9,
      queries: 1000,
      queryErrors: 25,
      cacheHits: 300,
      cacheMisses: 100,
    },
    trend: [
      {
        at: NOW - 2 * 24 * HOUR,
        views: 10,
        panelRuns: 40,
        panelErrors: 1,
        queries: 50,
        queryErrors: 2,
      },
      {
        at: NOW - 24 * HOUR,
        views: 12,
        panelRuns: 44,
        panelErrors: 0,
        queries: 51,
        queryErrors: 0,
      },
    ],
    dashboards: [
      {
        orgId: "o1",
        orgName: "Analytical Engines",
        id: "d1",
        title: "Sales by region",
        views: 800,
        lastViewedAt: NOW - HOUR,
      },
      {
        orgId: "o2",
        orgName: "Difference Engines",
        id: "d9",
        title: "Engine status",
        views: 3,
        lastViewedAt: NOW - HOUR,
      },
    ],
    slowPanels: [
      {
        orgId: "o1",
        orgName: "Analytical Engines",
        dashboardId: "d1",
        dashboardTitle: "Sales by region",
        panelId: "p7",
        panelTitle: "Orders per hour",
        runs: 120,
        errors: 0,
        cacheHits: 0,
        cacheMisses: 120,
        rows: 4000,
        p50Ms: 420,
        p95Ms: 2500,
        maxMs: 4100,
      },
    ],
    failingPanels: [
      {
        orgId: "o1",
        orgName: "Analytical Engines",
        dashboardId: "d1",
        dashboardTitle: "Sales by region",
        panelId: "p8",
        panelTitle: "",
        runs: 40,
        errors: 10,
        cacheHits: 0,
        cacheMisses: 0,
        rows: 0,
        p50Ms: 20,
        p95Ms: 90,
        maxMs: 100,
      },
    ],
    sources: [
      {
        orgId: "o1",
        orgName: "Analytical Engines",
        id: "s1",
        name: "Warehouse",
        kind: "postgres",
        queries: 1000,
        errors: 25,
        errorsTimeout: 20,
        errorsRejected: 0,
        errorsSource: 5,
        errorsOther: 0,
        cacheHits: 300,
        cacheMisses: 100,
        rows: 100000,
        p50Ms: 35,
        p95Ms: 800,
        maxMs: 3000,
      },
    ],
  };
}

export function sampleUnused(days = 30): UnusedDashboards {
  return {
    days,
    since: NOW - days * 24 * HOUR,
    recordedSince: NOW - 10 * 24 * HOUR,
    items: [
      {
        orgId: "o1",
        orgName: "Analytical Engines",
        id: "d3",
        title: "Old inventory",
        createdAt: NOW - 400 * 24 * HOUR,
        lastViewedAt: null,
      },
    ],
    total: 1,
  };
}

function initialState(): FakeUsageState {
  return { report: sampleReport(), unused: sampleUnused() };
}

const ORG_ROUTE = /^\/api\/orgs\/[^/]+\/usage(\/unused)?$/;

export function usageFake(): FakeArea<FakeUsageState> {
  const state = initialState();
  return {
    state,
    handle: (request) => {
      const match = ORG_ROUTE.exec(request.route);
      if (match === null || request.method !== "GET") {
        return undefined;
      }
      if (!request.permissions.has("audit:read")) {
        return error(403, "forbidden");
      }
      if (match[1] === undefined) {
        return json(200, state.report);
      }
      return json(200, { ...state.unused, days: Number(request.search.get("days") ?? 30) });
    },
  };
}

/** `/api/admin/usage` and `/api/admin/usage/unused`, for server administrators. */
export function handleUsageAdminRoute(
  state: FakeUsageState,
  server: FakeServer,
  rawPath: string,
  method: string,
): Response | undefined {
  const url = new URL(rawPath, "http://kalzit.test");
  if (method !== "GET" || !/^\/api\/admin\/usage(\/unused)?$/.test(url.pathname)) {
    return undefined;
  }
  if (!server.state.signedIn) {
    return error(401, "unauthenticated");
  }
  if (!server.state.user.isServerAdmin) {
    return error(403, "forbidden");
  }
  if (url.pathname.endsWith("/unused")) {
    return json(200, { ...state.unused, days: Number(url.searchParams.get("days") ?? 30) });
  }
  return json(200, state.report);
}
