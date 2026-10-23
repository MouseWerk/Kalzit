// The routes every area hangs off: the root, setup, sign-in and the signed-in app frame. Areas
// add their own routes under `appRoute` in `features/<area>/routes.tsx`.
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, Outlet, redirect } from "@tanstack/react-router";
import { meQuery, setupStatusQuery } from "../api/auth";
import { ORG_QUERY_KEY } from "../api/orgs";
import { LoginPage } from "../auth/LoginPage";
import { safeRedirect } from "../auth/redirect";
import { SetupPage } from "../auth/SetupPage";
import { ErrorPage, NotFoundPage } from "../pages/StatusPages";
import { AppShell } from "../shell/AppShell";

export interface RouterContext {
  queryClient: QueryClient;
}

export interface LoginSearch {
  redirect?: string | undefined;
  /** Set by signing out, so the sign-in page confirms it. */
  signedOut?: true | undefined;
}

/**
 * Keeps only a safe same-origin redirect target. The key is always returned, even as undefined:
 * the router merges the validated search over the raw one, so a key left out would keep the
 * unchecked value from the URL.
 */
export function parseLoginSearch(search: Record<string, unknown>): LoginSearch {
  return {
    redirect: safeRedirect(search.redirect),
    signedOut: search.signedOut === true || search.signedOut === "true" ? true : undefined,
  };
}

async function isSetupNeeded(queryClient: QueryClient): Promise<boolean> {
  const status = await queryClient.ensureQueryData(setupStatusQuery);
  return status.needed;
}

/**
 * Asks the server on every real navigation instead of trusting the cache, so a revoked session
 * or a changed role takes effect on the next page change, not after the cache expires. Preloads
 * (hovering a link) use the cache: they would otherwise send a request per hover, and the real
 * navigation that may follow checks again anyway.
 */
function currentUser(queryClient: QueryClient, preload: boolean) {
  return preload
    ? queryClient.ensureQueryData(meQuery)
    : queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: ErrorPage,
  notFoundComponent: NotFoundPage,
});

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if (!(await isSetupNeeded(context.queryClient))) {
      throw redirect({ to: "/login", replace: true });
    }
  },
  component: SetupPage,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: parseLoginSearch,
  beforeLoad: async ({ context, search, preload }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
    const me = await currentUser(context.queryClient, preload);
    if (me !== null) {
      throw redirect({ href: search.redirect ?? "/", replace: true });
    }
  },
  component: LoginPage,
});

/** Everything behind sign-in. The guard hands the signed-in user to every page below it. */
export const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_app",
  beforeLoad: async ({ context, location, preload }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
    const me = await currentUser(context.queryClient, preload);
    if (me === null) {
      const back = safeRedirect(location.href);
      throw redirect({
        to: "/login",
        search: back === undefined || back === "/" ? {} : { redirect: back },
        replace: true,
      });
    }
    if (!preload) {
      // Permissions can change with the role, like the session; refresh them in the background.
      void context.queryClient.invalidateQueries({ queryKey: [ORG_QUERY_KEY] });
    }
    return { me };
  },
  component: AppShell,
});
