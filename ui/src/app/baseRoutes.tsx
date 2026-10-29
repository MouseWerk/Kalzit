// The routes every area hangs off: the root, setup, sign-in and the signed-in app frame. Areas
// add their own routes under `appRoute` in `features/<area>/routes.tsx`.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  lazyRouteComponent,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { meQuery, setupStatusQuery } from "../api/auth";
import { ORG_QUERY_KEY } from "../api/orgs";
import { LoginPage } from "../auth/LoginPage";
import { safeRedirect } from "../auth/redirect";
import { SetupPage } from "../auth/SetupPage";
import { HELP_PAGES, HelpPage } from "../help/HelpPage";
import { ErrorPage, NotFoundPage } from "../pages/StatusPages";
import { AppShell } from "../shell/AppShell";

export interface RouterContext {
  queryClient: QueryClient;
}

export interface LoginSearch {
  redirect?: string | undefined;
  /** Set by signing out, so the sign-in page confirms it. */
  signedOut?: true | undefined;
  /** Set when a request found the session ended, so the sign-in page says why. */
  expired?: true | undefined;
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
    expired: search.expired === true || search.expired === "true" ? true : undefined,
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
  // Once setup is done the page only says so; someone signed in goes on to Start (a reload of
  // the last step of setup).
  beforeLoad: async ({ context, preload }) => {
    if (!(await isSetupNeeded(context.queryClient))) {
      const me = await currentUser(context.queryClient, preload);
      if (me !== null) {
        throw redirect({ to: "/", replace: true });
      }
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

/**
 * The pages behind the links Kalzit mails (docs/api/mail.md): open without a session, since the
 * link's token is what counts. The token is in the fragment, which never reaches a server.
 */
export const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite",
  beforeLoad: async ({ context }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: lazyRouteComponent(() => import("../auth/InvitePage"), "InvitePage"),
});

export const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  beforeLoad: async ({ context }) => {
    if (await isSetupNeeded(context.queryClient)) {
      throw redirect({ to: "/setup", replace: true });
    }
  },
  component: lazyRouteComponent(() => import("../auth/ResetPasswordPage"), "ResetPasswordPage"),
});

/**
 * The guide pages needed before signing in (getting started, installation), shipped with the UI
 * and readable without an account. Other names are not found.
 */
export const helpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/help/$page",
  beforeLoad: ({ params }) => {
    if (!HELP_PAGES.some((page) => page === params.page)) {
      throw notFound();
    }
  },
  component: HelpPage,
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
