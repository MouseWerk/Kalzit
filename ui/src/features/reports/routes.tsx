import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { loadArea } from "../../i18n/i18n";

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

export const REPORT_FILTERS = ["mine", "problems"] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

export interface ReportsSearch {
  filter?: ReportFilter | undefined;
  /** Only the reports of this dashboard ("Berichte zu diesem Dashboard"). */
  dashboard?: string | undefined;
}

export interface NewReportSearch {
  /** "Bericht anlegen" on a dashboard: it, with the range and values chosen there. */
  dashboard?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  vars?: Record<string, string> | undefined;
  /** "Duplizieren": the report the new one starts from. */
  copy?: string | undefined;
}

function variables(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([name, item]): [string, string][] =>
    typeof item === "string" ? [[name, item]] : [],
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

const reportsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports",
  validateSearch: (search: Record<string, unknown>): ReportsSearch => ({
    filter: REPORT_FILTERS.find((filter) => filter === search.filter),
    dashboard: text(search.dashboard),
  }),
  component: lazyRouteComponent(
    () => loadArea("reports").then(() => import("./ReportsPage")),
    "ReportsPage",
  ),
});

const newReportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports/new",
  validateSearch: (search: Record<string, unknown>): NewReportSearch => ({
    dashboard: text(search.dashboard),
    from: text(search.from),
    to: text(search.to),
    vars: variables(search.vars),
    copy: text(search.copy),
  }),
  component: lazyRouteComponent(
    () => loadArea("reports").then(() => import("./ReportEditorPage")),
    "NewReportPage",
  ),
});

const editReportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports/$reportId",
  component: lazyRouteComponent(
    () => loadArea("reports").then(() => import("./ReportEditorPage")),
    "EditReportPage",
  ),
});

const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/reports/$reportId/runs",
  component: lazyRouteComponent(
    () => loadArea("reports").then(() => import("./ReportRunsPage")),
    "ReportRunsPage",
  ),
});

export const reportsRoutes = [reportsRoute, newReportRoute, editReportRoute, runsRoute] as const;
