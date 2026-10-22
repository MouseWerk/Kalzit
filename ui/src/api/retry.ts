import { type ErrorCode, isApiError, isRecord } from "./client";

// Only failures that may go away on their own are retried; a 4xx answer will not change.
// `busy` (503) means the database was busy and the request changed nothing.
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["network", "internal", "busy"]);
const MAX_RETRIES = 2;

/**
 * Kalzit's own busy answer: the `busy` code in the error body. A bare 503 (from a proxy, say)
 * also reads as `busy` for its message, but nothing vouches that the request changed nothing.
 */
export function isBusyAnswer(error: unknown): boolean {
  if (!isApiError(error, "busy")) {
    return false;
  }
  const body = error.body;
  return isRecord(body) && isRecord(body.error) && body.error.code === "busy";
}

/** Whether a failed read is tried again (`failureCount` failures so far). */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && isApiError(error) && RETRYABLE.has(error.code);
}

/**
 * A change is tried again only when the server itself said it changed nothing (a busy answer);
 * any other failure may have come after the change was saved. Queries on a data source follow
 * the same rule: a slow or broken source is not asked the same heavy query again.
 */
export function shouldRetryMutation(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_RETRIES && isBusyAnswer(error);
}

/** The wait before the next try: what the server asked for (`Retry-After`), else growing. */
export function retryDelayMs(failureCount: number, error: unknown): number {
  if (isApiError(error) && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

/** TanStack Query options for requests that run queries on a data source. */
export const BUSY_RETRY = {
  retry: (failureCount: number, error: Error) => shouldRetryMutation(failureCount, error),
  retryDelay: (failureCount: number, error: Error) => retryDelayMs(failureCount, error),
};
