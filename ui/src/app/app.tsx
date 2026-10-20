import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { safeRedirect } from "../auth/redirect";
import { type AppRouter, createAppRouter } from "./router";

// Only failures that may go away on their own are retried; a 4xx answer will not change.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["network", "internal"]);
const MAX_RETRIES = 2;

export interface AppOptions {
  history?: RouterHistory;
  /** Tests turn retries off so failures surface at once. */
  retry?: boolean;
}

export interface GranitApp {
  queryClient: QueryClient;
  router: AppRouter;
}

/**
 * Builds the query client and router and wires them together: any request that comes back
 * `unauthenticated` (an expired session) drops the cached user and sends the user to sign in,
 * returning to the current page afterwards.
 */
export function createApp(options: AppOptions = {}): GranitApp {
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
        retry:
          options.retry === false
            ? false
            : (failureCount, error) =>
                failureCount < MAX_RETRIES && isApiError(error) && RETRYABLE.has(error.code),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });

  router = createAppRouter(queryClient, options.history);
  return { queryClient, router };
}

export function App({ app }: { app: GranitApp }) {
  return (
    <QueryClientProvider client={app.queryClient}>
      <RouterProvider router={app.router} />
    </QueryClientProvider>
  );
}
