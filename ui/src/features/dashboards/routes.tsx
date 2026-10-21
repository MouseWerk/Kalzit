import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { DashboardPage } from "./DashboardPage";
import { DashboardsPage } from "./DashboardsPage";
import { TrashPage } from "./TrashPage";
import { VersionsPage } from "./VersionsPage";

export interface DashboardsSearch {
  folder?: string | undefined;
  q?: string | undefined;
}

export interface DashboardSearch {
  /** A time range other than the dashboard's own, as text ("now-1h"), so links can share it. */
  from?: string | undefined;
  to?: string | undefined;
  /** Opens in edit mode, as after creating a dashboard. */
  edit?: boolean | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// The dashboards area's pages. Nested routes of this area go here too.
const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards",
  validateSearch: (search: Record<string, unknown>): DashboardsSearch => ({
    folder: text(search.folder),
    q: text(search.q),
  }),
  component: DashboardsPage,
});

const trashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/trash",
  component: TrashPage,
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId",
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    from: text(search.from),
    to: text(search.to),
    edit: search.edit === true || search.edit === "true" ? true : undefined,
  }),
  component: DashboardPage,
});

const versionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId/versions",
  component: VersionsPage,
});

export const dashboardsRoutes = [
  dashboardsRoute,
  trashRoute,
  dashboardRoute,
  versionsRoute,
] as const;
