import type { QueryClient } from "@tanstack/react-query";
import { createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { adminRoutes } from "../features/admin/routes";
import { askRoutes } from "../features/ai/chat/routes";
import { alertingRoutes } from "../features/alerting/routes";
import { dashboardsRoutes } from "../features/dashboards/routes";
import { datasourcesRoutes } from "../features/datasources/routes";
import { exploreRoutes } from "../features/explore/routes";
import { appsRoutes } from "../features/plugins/apps/routes";
import { reportsRoutes } from "../features/reports/routes";
import { settingsRoutes } from "../features/settings/routes";
import { handbookRoutes } from "../handbook/routes";
import { basePath } from "../lib/basePath";
import { forgetClippingAncestors } from "../lib/tooltipPlace";
import { HomePage } from "../pages/HomePage";
import { PendingPage } from "../pages/StatusPages";
import { redirectToStartDashboard } from "../preferences/startDashboard";
import {
  anmeldenRoute,
  appRoute,
  confirmEmailRoute,
  helpRoute,
  inviteRoute,
  localLoginRoute,
  loginRoute,
  publicDashboardRoute,
  publicOtherRoute,
  publicSnapshotRoute,
  registerRoute,
  resetPasswordRoute,
  rootRoute,
  setupRoute,
  ssoTestRoute,
} from "./baseRoutes";
import { grafanaAddressRoutes } from "./grafanaAddresses";

export { type LoginSearch, parseLoginSearch, type RouterContext } from "./baseRoutes";

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: ({ context, preload }) =>
    redirectToStartDashboard(context.queryClient, context.me, preload),
  component: HomePage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  anmeldenRoute,
  localLoginRoute,
  ssoTestRoute,
  helpRoute,
  inviteRoute,
  resetPasswordRoute,
  confirmEmailRoute,
  registerRoute,
  publicDashboardRoute,
  publicSnapshotRoute,
  publicOtherRoute,
  appRoute.addChildren([
    homeRoute,
    ...dashboardsRoutes,
    ...exploreRoutes,
    ...askRoutes,
    ...alertingRoutes,
    ...reportsRoutes,
    ...datasourcesRoutes,
    ...adminRoutes,
    ...settingsRoutes,
    ...appsRoutes,
    ...grafanaAddressRoutes,
    ...handbookRoutes,
  ]),
]);
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    // Behind a reverse proxy under a sub-path (`server.base_path`), every route lives below it.
    basepath: basePath() || "/",
    context: { queryClient },
    ...(history === undefined ? {} : { history }),
    defaultPreload: "intent",
    // The query cache owns freshness; the router should not keep its own stale copies.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingPage,
    scrollRestoration: true,
    // Next to the sidebar the page scrolls in the main area, not the window: a new page starts
    // at its top there too, and Back restores where it was (AppShell names it for that).
    scrollToTopSelectors: ["#main"],
  });
  // Another page may put the same charts into other scroll boxes: tooltips look up again what
  // clips them (lib/tooltipPlace.ts caches it between pointer moves).
  router.subscribe("onResolved", forgetClippingAncestors);
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
