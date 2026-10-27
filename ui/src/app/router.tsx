import type { QueryClient } from "@tanstack/react-query";
import { createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import { adminRoutes } from "../features/admin/routes";
import { dashboardsRoutes } from "../features/dashboards/routes";
import { datasourcesRoutes } from "../features/datasources/routes";
import { exploreRoutes } from "../features/explore/routes";
import { settingsRoutes } from "../features/settings/routes";
import { HomePage } from "../pages/HomePage";
import { PendingPage } from "../pages/StatusPages";
import { redirectToStartDashboard } from "../preferences/startDashboard";
import { appRoute, helpRoute, loginRoute, rootRoute, setupRoute } from "./baseRoutes";

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
  helpRoute,
  appRoute.addChildren([
    homeRoute,
    ...dashboardsRoutes,
    ...exploreRoutes,
    ...datasourcesRoutes,
    ...adminRoutes,
    ...settingsRoutes,
  ]),
]);
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history === undefined ? {} : { history }),
    defaultPreload: "intent",
    // The query cache owns freshness; the router should not keep its own stale copies.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingPage,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
