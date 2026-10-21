import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { meQuery } from "../api/auth";
import { type ErrorCode, isApiError, isRecord } from "../api/client";
import { safeRedirect } from "../auth/redirect";
import { type AppRouter, createAppRouter } from "./router";

// Only failures that may go away on their own are retried; a 4xx answer will not change.
// `busy` (503) means the database was busy and the request changed nothing.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["network", "internal", "busy"]);
const MAX_RETRIES = 2;

/** Whether a failed query is tried again (`failureCount` failures so far). */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && isApiError(error) && RETRYABLE.has(error.code);
}

/**
 * A change is tried again only when the server itself said it changed nothing: a `busy` code in
 * the error body. A bare 503 (from a proxy, say) also reads as `busy` for its message, but nothing
 * vouches that the change did not happen, so it is not repeated; any other failure may have come
 * after the change was saved.
 */
export function shouldRetryMutation(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES || !isApiError(error, "busy")) {
    return false;
  }
  const body = error.body;
  return isRecord(body) && isRecord(body.error) && body.error.code === "busy";
}

/** The wait before the next try: what the server asked for (`Retry-After`), else growing. */
export function retryDelayMs(failureCount: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

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
