import {
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { forgetAccountData, meQuery } from "../api/auth";
import { isApiError, isSessionEnded, setSessionEndHandler } from "../api/client";
import { retryDelayMs, shouldRetryMutation, shouldRetryQuery } from "../api/retry";
import { safeRedirect } from "../auth/redirect";
import { type AppRouter, createAppRouter } from "./router";

export interface AppOptions {
  history?: RouterHistory;
  /** Tests turn retries off so failures surface at once. */
  retry?: boolean;
}

export interface KalzitApp {
  queryClient: QueryClient;
  router: AppRouter;
}

/**
 * Builds the query client and router and wires them together: any request that comes back
 * `unauthenticated` (an expired session) drops the cached user and sends the user to sign in,
 * returning to the current page afterwards.
 */
export function createApp(options: AppOptions = {}): KalzitApp {
  let router: AppRouter | undefined;

  function onError(error: unknown) {
    if (!isApiError(error, "unauthenticated") || router === undefined) {
      return;
    }
    queryClient.setQueryData(meQuery.queryKey, null);
    forgetAccountData(queryClient);
    // A request that was on its way when the guard already sent the user to sign in must not
    // send them there again: that would drop the page to return to.
    if (router.state.location.pathname === "/login") {
      return;
    }
    const back = safeRedirect(router.state.location.href);
    void router.navigate({
      to: "/login",
      search:
        back === undefined || back === "/" ? { expired: true } : { redirect: back, expired: true },
      replace: true,
    });
  }

  /**
   * A read refused or cancelled because the session ended has not failed: it goes back to what it
   * had, as a cancelled read does, instead of showing an error on a page that is being left.
   */
  function onQueryError(error: unknown, query: Query<unknown, unknown, unknown, QueryKey>) {
    if (!isSessionEnded(error)) {
      onError(error);
      return;
    }
    const hasData = query.state.data !== undefined;
    query.setState({
      status: hasData ? "success" : "pending",
      fetchStatus: "idle",
      error: null,
      fetchFailureCount: 0,
      fetchFailureReason: null,
    });
  }

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: onQueryError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : shouldRetryQuery,
        retryDelay: retryDelayMs,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: options.retry === false ? false : shouldRetryMutation,
        retryDelay: retryDelayMs,
      },
    },
  });

  // When the session ends its reads stop as cancelled, back to where they were, rather than
  // failing with the cancelled request.
  setSessionEndHandler(() => void queryClient.cancelQueries());

  router = createAppRouter(queryClient, options.history);
  return { queryClient, router };
}

export function App({ app }: { app: KalzitApp }) {
  return (
    <QueryClientProvider client={app.queryClient}>
      <RouterProvider router={app.router} />
    </QueryClientProvider>
  );
}
