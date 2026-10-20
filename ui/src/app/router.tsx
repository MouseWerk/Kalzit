import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { meQuery, setupStatusQuery } from "../api/auth";
import { LoginPage } from "../auth/LoginPage";
import { safeRedirect } from "../auth/redirect";
import { SetupPage } from "../auth/SetupPage";
import {
  AdminPage,
  DashboardsPage,
  DataSourcesPage,
  ExplorePage,
  HomePage,
} from "../pages/PlaceholderPages";
import { ErrorPage, NotFoundPage, PendingPage } from "../pages/StatusPages";
import { AppShell } from "../shell/AppShell";

export interface RouterContext {
  queryClient: QueryClient;
}

export interface LoginSearch {
  redirect?: string | undefined;
}

/**
 * Keeps only a safe same-origin redirect target. The key is always returned, even as undefined:
 * the router merges the validated search over the raw one, so a key left out would keep the
 * unchecked value from the URL.
 */
export function parseLoginSearch(search: Record<string, unknown>): LoginSearch {
  return { redirect: safeRedirect(search.redirect) };
}

async function isSetupNeeded(queryClient: QueryClient): Promise<boolean> {
  const status = await queryClient.ensureQueryData(setupStatusQuery);
  return status.needed;
}

/**
 * Asks the server on every guarded navigation instead of trusting the cache, so a revoked
 * session or a changed role takes effect on the next page change, not after the cache expires.
 */
function currentUser(queryClient: QueryClient) {
  return queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: ErrorPage,
  notFoundComponent: NotFoundPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if (!(await isSetupNeeded(context.queryClient))) {
      throw redirect({ to: "/login", replace: true });
    }
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: parseLoginSearch,
  beforeLoad: async ({ context, search }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
    const me = await currentUser(context.queryClient);
    if (me !== null) {
      throw redirect({ href: search.redirect ?? "/", replace: true });
    }
  },
  component: LoginPage,
});

/** Everything behind sign-in. The guard hands the signed-in user to every page below it. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context, location }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
    const me = await currentUser(context.queryClient);
    if (me === null) {
      const back = safeRedirect(location.href);
      throw redirect({
        to: "/login",
        search: back === undefined || back === "/" ? {} : { redirect: back },
        replace: true,
      });
    }
    return { me };
  },
  component: AppShell,
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });

const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards",
  component: DashboardsPage,
});

const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore",
  component: ExplorePage,
});

const dataSourcesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources",
  component: DataSourcesPage,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: AdminPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([homeRoute, dashboardsRoute, exploreRoute, dataSourcesRoute, adminRoute]),
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
