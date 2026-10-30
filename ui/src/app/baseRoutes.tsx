// The routes every area hangs off: the root, setup, sign-in and the signed-in app frame. Areas
// add their own routes under `appRoute` in `features/<area>/routes.tsx`.
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  notFound,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { meQuery, setupStatusQuery, signInProvidersQuery } from "../api/auth";
import { ORG_QUERY_KEY } from "../api/orgs";
import { LocalLoginPage, LoginPage } from "../auth/LoginPage";
import { safeRedirect } from "../auth/redirect";
import { SetupPage } from "../auth/SetupPage";
import { SsoTestDonePage } from "../auth/SsoTestDonePage";
import { SSO_OUTCOMES, type SsoOutcome } from "../auth/ssoOutcome";
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
  /** How a sign-in through a provider ended, when the server sent the browser back here. */
  sso?: SsoOutcome | undefined;
  /** The provider of that sign-in (its slug). */
  provider?: string | undefined;
  /** The error id that leads admins to the audit entry (`7Q2K-91XD`). */
  ref?: string | undefined;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REF = /^[A-Za-z0-9-]{1,40}$/;

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
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
    sso: SSO_OUTCOMES.find((outcome) => outcome === search.sso),
    provider: matching(search.provider, SLUG),
    ref: matching(search.ref, REF),
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
    // The buttons of the identity providers come first; the page shows once they are known, so
    // the password form does not flash and fold away. Without an answer it shows the plain form.
    await context.queryClient.ensureQueryData(signInProvidersQuery).catch(() => undefined);
  },
  component: LoginPage,
});

/**
 * The German address the server sends the browser back to after a sign-in through a provider
 * (`/anmelden?sso=failed&provider=...&ref=...`); it shows the sign-in page with the same search.
 */
export const anmeldenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/anmelden",
  validateSearch: parseLoginSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/login", search, replace: true });
  },
});

/**
 * The fixed, unlinked sign-in with a password (`/anmelden/lokal`): always the form, posting to
 * `/api/auth/login/local`, so the break-glass admin gets in while password sign-in is off.
 */
export const localLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/anmelden/lokal",
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
  component: LocalLoginPage,
});

/** Where a test sign-in of the administration ends, in the window it opened. */
export const ssoTestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/anmelden/sso-test",
  component: SsoTestDonePage,
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
