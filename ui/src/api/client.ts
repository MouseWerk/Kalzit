/**
 * The one HTTP client of the UI. Every server request goes through `request` so credentials,
 * headers and error mapping live in one place (a guard test fails on `fetch(` anywhere else).
 */

import type { ErrorCode as GeneratedErrorCode } from "./generated/shapes";

/** Error codes the server sends in `{"error":{"code","message","field"?}}`, generated from it. */
export type ServerErrorCode = GeneratedErrorCode;

// The runtime check needs values, the generated file has only types. A Record over the generated
// union makes the typecheck fail when the server adds or drops a code and this is not updated.
const SERVER_ERROR_CODE_SET: Record<ServerErrorCode, true> = {
  validation: true,
  unauthenticated: true,
  forbidden: true,
  not_found: true,
  method_not_allowed: true,
  payload_too_large: true,
  conflict: true,
  version_conflict: true,
  rate_limited: true,
  cross_origin: true,
  invalid_credentials: true,
  invalid_code: true,
  confirmation_required: true,
  setup_done: true,
  invalid_setup_token: true,
  setup_token_expired: true,
  datasource_error: true,
  datasource_target_blocked: true,
  query_timeout: true,
  query_rejected: true,
  ai_unavailable: true,
  ai_provider_error: true,
  busy: true,
  internal: true,
};

export const SERVER_ERROR_CODES = Object.keys(SERVER_ERROR_CODE_SET) as ServerErrorCode[];

/**
 * Codes the client adds itself: `network` when the server could not be reached at all,
 * `invalid_response` when it answered with something outside the contract (a proxy error page),
 * `download_interrupted` when a file download began (200) and broke off before its end.
 */
export type ErrorCode = ServerErrorCode | "network" | "invalid_response" | "download_interrupted";

export class ApiError extends Error {
  readonly code: ErrorCode;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /**
   * The input field a `validation` error is about, when the server names one (an optional
   * `field` next to code and message); forms use it to mark and focus that field.
   */
  readonly field: string | undefined;
  /**
   * The whole parsed error body. A `version_conflict` carries the stored resource as `current`
   * next to `error`, so a conflict dialog can show it without fetching again.
   */
  readonly body: unknown;
  /**
   * How long the server asked to wait before trying again (`Retry-After`, in milliseconds), sent
   * with `busy` (the request changed nothing and may be repeated) and with `rate_limited` (the
   * time until another attempt is counted).
   */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    field?: string,
    body?: unknown,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.field = field;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }

  /** The stored resource of a `version_conflict`, when the server sent one. */
  get current(): unknown {
    return isRecord(this.body) ? this.body.current : undefined;
  }
}

export function isApiError(error: unknown, code?: ErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return typeof value === "string" && Object.hasOwn(SERVER_ERROR_CODE_SET, value);
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
    case 405:
      return "method_not_allowed";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    case 503:
      return "busy";
    default:
      return "internal";
  }
}

/** `Retry-After` in whole seconds (the form the server sends), as milliseconds. */
function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header == null || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  return Number(header.trim()) * 1000;
}

/** Maps a non-2xx response body to an ApiError. Unknown codes fall back to the status. */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): ApiError {
  const retryAfterMs = parseRetryAfter(retryAfter);
  const error = isRecord(body) ? body.error : undefined;
  if (isRecord(error)) {
    const code = error.code;
    const message = typeof error.message === "string" ? error.message : "";
    const field = typeof error.field === "string" ? error.field : undefined;
    // A rate limit names the wait in its body too, for clients behind a proxy that drops the
    // header.
    const waitSecs = error.retryAfterSecs;
    const bodyWaitMs =
      typeof waitSecs === "number" && Number.isFinite(waitSecs) && waitSecs > 0
        ? Math.ceil(waitSecs) * 1000
        : undefined;
    return new ApiError(
      isServerErrorCode(code) ? code : codeForStatus(status),
      status,
      message,
      field,
      body,
      retryAfterMs ?? bodyWaitMs,
    );
  }
  return new ApiError(
    codeForStatus(status),
    status,
    `HTTP ${status}`,
    undefined,
    body,
    retryAfterMs,
  );
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  /** Cancels the request; the rejection is the AbortError itself, not an ApiError. */
  signal?: AbortSignal | undefined;
}

/**
 * Sends a request and returns the parsed JSON body (undefined for 204). Throws ApiError for every
 * failure, so callers only ever handle one error type; a request cancelled through
 * `options.signal` rejects with the signal's reason instead (an AbortError unless the caller gave
 * another reason), which is not a failure to report.
 */
export async function request(
  method: Method,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const init: RequestInit = { method, credentials: "same-origin", headers };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }
  if (body instanceof FormData) {
    // An upload: the browser sets the multipart type with its boundary.
    init.body = body;
  } else if (body instanceof Blob) {
    // A file sent as it is (a plugin package), with the type it was given.
    headers["Content-Type"] = body.type === "" ? "application/octet-stream" : body.type;
    init.body = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  // A cancelled request is not a failure to report: whatever the signal was aborted with (an
  // AbortError or the caller's own reason) is passed through unchanged, also when the abort
  // happens while the body is still being read.
  const cancelled = (cause: unknown) =>
    options?.signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    throw new ApiError("network", 0, cause instanceof Error ? cause.message : String(cause));
  }

  if (response.status === 204) {
    return undefined;
  }

  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    throw new ApiError(
      "network",
      response.status,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
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
    throw errorFromResponse(response.status, parsed, response.headers.get("Retry-After"));
  }
  return parsed;
}

/** A file the server sent as an attachment. */
export interface DownloadedFile {
  blob: Blob;
  /** From `Content-Disposition`; the server sends only letters, digits, `-`, `_` and the dot. */
  filename: string;
}

/**
 * POSTs a JSON body and returns the file the server answers with (exports). Failures are
 * ApiErrors from the JSON error body, as with `request`.
 */
export async function requestFile(
  path: string,
  body: unknown,
  options?: RequestOptions,
): Promise<DownloadedFile> {
  const init: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "*/*", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }
  const cancelled = (cause: unknown) =>
    options?.signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    throw new ApiError("network", 0, cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = undefined;
    }
    throw errorFromResponse(response.status, parsed, response.headers.get("Retry-After"));
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([\w.-]+)"/.exec(disposition)?.[1] ?? "kalzit-export";
  try {
    return { blob: await response.blob(), filename };
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    // The answer was 200: the file broke off on the way (the server gave it up, the connection
    // dropped). Nothing was saved.
    throw new ApiError(
      "download_interrupted",
      response.status,
      cause instanceof Error ? cause.message : "",
    );
  }
}

/** One server-sent event: its name and its JSON data. */
export interface StreamEvent {
  event: string;
  data: unknown;
}

/** Splits `buffer` into complete events and the rest that is still arriving. */
export function parseEventStream(buffer: string): { events: StreamEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: StreamEvent[] = [];
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (data.length === 0) {
      // A comment or keep-alive.
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(data.join("\n")) });
    } catch {
      // Not JSON: not an event this UI asked for.
    }
  }
  return { events, rest };
}

/**
 * POSTs a JSON body and reads the answer as server-sent events (the AI calls), handing each one
 * to `onEvent` as it arrives. A refusal before the stream starts is an ApiError from its JSON
 * body, as with `request`; aborting `options.signal` closes the request, which cancels the call
 * on the server, and rejects with the signal's reason.
 */
export async function requestStream(
  path: string,
  body: unknown,
  onEvent: (event: StreamEvent) => void,
  options?: RequestOptions,
): Promise<void> {
  const init: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (options?.signal !== undefined) {
    init.signal = options.signal;
  }
  const cancelled = (cause: unknown) =>
    options?.signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    throw new ApiError("network", 0, cause instanceof Error ? cause.message : String(cause));
  }
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      parsed = undefined;
    }
    throw errorFromResponse(response.status, parsed, response.headers.get("Retry-After"));
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (final: boolean) => {
    const { events, rest } = parseEventStream(final ? `${buffer}\n\n` : buffer);
    buffer = final ? "" : rest;
    for (const event of events) {
      onEvent(event);
    }
  };
  try {
    if (response.body === null) {
      buffer = await response.text();
    } else {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        flush(false);
      }
      buffer += decoder.decode();
    }
  } catch (cause) {
    if (cancelled(cause)) {
      throw cause;
    }
    throw new ApiError(
      "network",
      response.status,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  flush(true);
}

/** Narrows a parsed body or throws `invalid_response`, so a contract mismatch fails loudly. */
export function expectShape<T>(value: unknown, guard: (v: unknown) => v is T, what: string): T {
  if (!guard(value)) {
    throw new ApiError("invalid_response", 200, `unexpected ${what} response`);
  }
  return value;
}

/**
 * Opens a WebSocket to a server path on this origin (`ws:` or `wss:` as the page was loaded).
 * The session cookie signs it in; the browser sends the page's Origin, which the server checks.
 */
export function openSocket(path: string): WebSocket {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
