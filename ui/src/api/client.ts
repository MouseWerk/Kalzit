/**
 * The one HTTP client of the UI. Every server request goes through `request` so credentials,
 * headers and error mapping live in one place (a guard test fails on `fetch(` anywhere else).
 */

/** Error codes the server sends in `{"error":{"code","message"}}`. */
export const SERVER_ERROR_CODES = [
  "validation",
  "unauthenticated",
  "forbidden",
  "invalid_credentials",
  "rate_limited",
  "cross_origin",
  "setup_done",
  "invalid_setup_token",
  "not_found",
  "internal",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

/**
 * Codes the client adds itself: `network` when the server could not be reached at all,
 * `invalid_response` when it answered with something outside the contract (a proxy error page).
 */
export type ErrorCode = ServerErrorCode | "network" | "invalid_response";

export class ApiError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /**
   * The input field a `validation` error is about, when the server names one (an optional
   * `field` next to code and message); forms use it to mark and focus that field.
   */
  readonly field: string | undefined;

  constructor(code: ErrorCode, status: number, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return (SERVER_ERROR_CODES as readonly unknown[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fallback when an error body is missing or unreadable, chosen from the status alone. */
function codeForStatus(status: number): ServerErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "validation";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 429:
      return "rate_limited";
    default:
      return "internal";
  }
}

/** Maps a non-2xx response body to an ApiError. Unknown codes fall back to the status. */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error)) {
    const code = error.code;
    const message = typeof error.message === "string" ? error.message : "";
    const field = typeof error.field === "string" ? error.field : undefined;
    return new ApiError(
      isServerErrorCode(code) ? code : codeForStatus(status),
      status,
      message,
      field,
    );
  }
  return new ApiError(codeForStatus(status), status, `HTTP ${status}`);
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Sends a request and returns the parsed JSON body (undefined for 204). Throws ApiError for every
 * failure, so callers only ever handle one error type.
 */
export async function request(method: Method, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError("network", 0, cause instanceof Error ? cause.message : String(cause));
  }

  if (response.status === 204) {
    return undefined;
  }

  const text = await response.text();
  let parsed: unknown;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new ApiError("invalid_response", response.status, "response is not JSON");
      }
      parsed = undefined;
    }
  }

  if (!response.ok) {
    throw errorFromResponse(response.status, parsed);
  }
  return parsed;
}

/** Narrows a parsed body or throws `invalid_response`, so a contract mismatch fails loudly. */
export function expectShape<T>(value: unknown, guard: (v: unknown) => v is T, what: string): T {
  if (!guard(value)) {
    throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
  }
  return value;
}
