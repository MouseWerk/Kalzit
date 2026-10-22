import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { meQuery } from "../api/auth";
import { isApiError } from "../api/client";
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
    const back = safeRedirect(router.state.location.href);
    void router.navigate({
      to: "/login",
      search: back === undefined || back === "/" ? {} : { redirect: back },
      replace: true,
    });
  }

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
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
