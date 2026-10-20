import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { DashboardsPage } from "../../pages/PlaceholderPages";

// The dashboards area's pages. Nested routes of this area go here too.
const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards",
  component: DashboardsPage,
});

export const dashboardsRoutes = [dashboardsRoute] as const;
