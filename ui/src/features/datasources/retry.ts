import { isApiError, isRecord } from "../../api/client";

const MAX_RETRIES = 2;

/** Kalzit's own busy answer: the `busy` code in the error body, not just a 503 status. */
function isBusyAnswer(error: unknown): boolean {
  if (!isApiError(error, "busy")) {
    return false;
  }
  const body = error.body;
  return isRecord(body) && isRecord(body.error) && body.error.code === "busy";
}

/**
 * Retries for requests that run queries on a data source (Explore, panels, variable options,
 * schema). A failure of the source itself is not asked again: a slow or broken source would get
 * the same heavy query once more. Only Kalzit's own `busy` answer (its database was busy, the
 * request did nothing) is tried again, after the `Retry-After` the server sent. The same rule as
 * `shouldRetryMutation` in app/app.tsx, which this module cannot import (app imports the routes).
 */
export const BUSY_RETRY = {
  retry: (failureCount: number, error: Error) => failureCount < MAX_RETRIES && isBusyAnswer(error),
  retryDelay: (failureCount: number, error: Error) =>
    isApiError(error) && error.retryAfterMs !== undefined
      ? error.retryAfterMs
      : Math.min(1000 * 2 ** failureCount, 30_000),
};
