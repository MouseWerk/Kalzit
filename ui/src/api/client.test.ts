import { describe, expect, it, vi } from "vitest";
import { generatedUnion } from "../test/generated";
import { fetchMe, isMe, login, logout } from "./auth";
import {
  ApiError,
  errorFromResponse,
  isSessionEnded,
  request,
  requestFile,
  requestStream,
  SERVER_ERROR_CODES,
} from "./client";

function respond(status: number, body: string | null, contentType = "application/json") {
  const fetchMock = vi.fn(
    async () => new Response(body, { status, headers: { "Content-Type": contentType } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("request", () => {
  it("sends JSON with the session cookie of the same origin", async () => {
    const fetchMock = respond(200, '{"ok":true}');
    await expect(request("POST", "/api/auth/login", { email: "a@b.c" })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: '{"email":"a@b.c"}',
      // The session's signal: signing out cancels the request (see "ending the session").
      signal: expect.any(AbortSignal),
    });
  });

  it("sends no body and no content type for a GET", async () => {
    const fetchMock = respond(200, '{"needed":false}');
    await request("GET", "/api/setup");
    expect(fetchMock).toHaveBeenCalledWith("/api/setup", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });
  });

  it("returns undefined for 204 No Content", async () => {
    respond(204, null);
    await expect(request("POST", "/api/auth/logout")).resolves.toBeUndefined();
  });

  it("maps the server's error envelope to code, status and message", async () => {
    respond(401, '{"error":{"code":"invalid_credentials","message":"bad login"}}');
    const error = await failure(request("POST", "/api/auth/login", {}));
    expect(error.code).toBe("invalid_credentials");
    expect(error.status).toBe(401);
    expect(error.message).toBe("bad login");
  });

  it("knows exactly the server's error codes", () => {
    expect([...SERVER_ERROR_CODES].sort()).toEqual(generatedUnion("ErrorCode").sort());
  });

  it.each(generatedUnion("ErrorCode"))("keeps the server code %s", async (code) => {
    respond(400, JSON.stringify({ error: { code, message: "" } }));
    expect((await failure(request("GET", "/api/x"))).code).toBe(code);
  });

  it("falls back to the status for an unknown code", async () => {
    respond(429, '{"error":{"code":"slow_down","message":""}}');
    expect((await failure(request("GET", "/api/x"))).code).toBe("rate_limited");
  });

  it.each([
    [400, "validation"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [405, "method_not_allowed"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "internal"],
    [502, "internal"],
    [503, "busy"],
  ] as const)("maps status %i without an envelope to %s", async (status, code) => {
    respond(status, "<html>Bad Gateway</html>", "text/html");
    const error = await failure(request("GET", "/api/x"));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it("keeps Retry-After of a busy answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"error":{"code":"busy","message":"the database is busy"}}', {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "2" },
          }),
      ),
    );
    const error = await failure(request("POST", "/api/x", {}));
    expect(error.code).toBe("busy");
    expect(error.retryAfterMs).toBe(2000);
    respond(503, '{"error":{"code":"busy","message":""}}');
    expect((await failure(request("GET", "/api/x"))).retryAfterMs).toBeUndefined();
  });

  it("keeps the stored resource of a version conflict", async () => {
    respond(
      409,
      '{"error":{"code":"version_conflict","message":"newer"},"current":{"version":4,"title":"Umsatz"}}',
    );
    const error = await failure(request("PUT", "/api/orgs/o/dashboards/d", { version: 3 }));
    expect(error.code).toBe("version_conflict");
    expect(error.current).toEqual({ version: 4, title: "Umsatz" });
  });

  it("passes the abort signal on and rejects a cancelled request with the AbortError itself", async () => {
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const outcome = await request("GET", "/api/x", undefined, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(outcome).not.toBeInstanceOf(ApiError);
    expect((outcome as Error).name).toBe("AbortError");
    // Joined with the session's signal: aborting the caller's aborts what fetch got.
    const sent = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(sent?.aborted).toBe(true);
    expect(sent?.reason).toBe(controller.signal.reason);
  });

  it("passes a custom abort reason through instead of reporting a network error", async () => {
    const reason = new Error("navigated away");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        throw init.signal?.reason;
      }),
    );
    const controller = new AbortController();
    controller.abort(reason);
    const outcome = await request("GET", "/api/x", undefined, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(outcome).toBe(reason);
  });

  it("passes an abort during the body read through", async () => {
    const controller = new AbortController();
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "text").mockImplementation(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const outcome = await request("GET", "/api/x", undefined, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(outcome).not.toBeInstanceOf(ApiError);
    expect((outcome as Error).name).toBe("AbortError");
  });

  it("reports a failed connection as network with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const error = await failure(request("GET", "/api/me"));
    expect(error.code).toBe("network");
    expect(error.status).toBe(0);
  });

  it("reports a file that breaks off after the 200 as an interrupted download", async () => {
    const response = new Response("x", {
      status: 200,
      headers: { "Content-Disposition": 'attachment; filename="a.csv"' },
    });
    vi.spyOn(response, "blob").mockRejectedValue(new TypeError("network error"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const error = await failure(requestFile("/api/export", {}));
    expect(error.code).toBe("download_interrupted");
    expect(error.status).toBe(200);
  });

  it("rejects a successful response that is not JSON", async () => {
    respond(200, "<html></html>", "text/html");
    expect((await failure(request("GET", "/api/me"))).code).toBe("invalid_response");
  });
});

describe("ending the session", () => {
  /** A fetch that answers the sign-out (when `answer` is called) and holds everything else open. */
  function holdingFetch() {
    let answered = false;
    let answer: () => void = () => {
      answered = true;
    };
    const fetchMock = vi.fn(
      (path: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (path.startsWith("/api/auth/logout")) {
            answer = () => resolve(new Response(null, { status: 204 }));
            if (answered) {
              answer();
            }
            return;
          }
          // Not answered before the sign-out: its answer would be a 401.
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, answer: () => answer() };
  }

  const settle = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

  it("cancels the requests on their way, also those started without a signal", async () => {
    const server = holdingFetch();
    const roles = settle(request("GET", "/api/orgs/o/roles"));
    const signingOut = logout();
    expect(isSessionEnded(await roles)).toBe(true);
    expect(((await roles) as Error).name).toBe("AbortError");
    server.answer();
    await signingOut;
  });

  it("cancels a request with a signal of its own too, and still follows that signal", async () => {
    const server = holdingFetch();
    const first = new AbortController();
    const second = new AbortController();
    const cancelledByCaller = settle(request("GET", "/api/a", undefined, { signal: first.signal }));
    const cancelledBySession = settle(
      request("GET", "/api/b", undefined, { signal: second.signal }),
    );
    const reason = new Error("left the page");
    first.abort(reason);
    expect(await cancelledByCaller).toBe(reason);
    const signingOut = logout();
    expect(isSessionEnded(await cancelledBySession)).toBe(true);
    // The caller's signal is left alone: it was the session that ended.
    expect(second.signal.aborted).toBe(false);
    server.answer();
    await signingOut;
  });

  it("cancels file downloads and streams on their way", async () => {
    const server = holdingFetch();
    const file = settle(requestFile("/api/export", {}));
    const stream = settle(requestStream("/api/ai/explain", {}, () => {}));
    const signingOut = logout();
    expect(isSessionEnded(await file)).toBe(true);
    expect(isSessionEnded(await stream)).toBe(true);
    server.answer();
    await signingOut;
  });

  it("sends nothing of the session until the sign-out is over", async () => {
    const server = holdingFetch();
    const signingOut = logout();
    expect(isSessionEnded(await settle(request("GET", "/api/orgs/o/roles")))).toBe(true);
    expect(isSessionEnded(await settle(requestFile("/api/export", {})))).toBe(true);
    expect(server.fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/auth/logout"]);
    server.answer();
    await signingOut;
    // The next session's requests go out again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await expect(request("GET", "/api/orgs/o/roles")).resolves.toEqual({});
  });

  it("still refuses requests after the server answered, until leaving the session is done", async () => {
    const server = holdingFetch();
    let duringThen: unknown;
    const signingOut = logout(false, async () => {
      // A poll of a page that is still on screen: the server already ended the session.
      duringThen = await settle(request("GET", "/api/orgs/o/dashboards"));
      // What the sign-in page reads needs no session and goes out.
      void request("GET", "/api/auth/providers", undefined, { sessionless: true }).catch(() => {});
    });
    server.answer();
    await signingOut;
    expect(isSessionEnded(duringThen)).toBe(true);
    expect(server.fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/auth/logout",
      "/api/auth/providers",
    ]);
  });

  it("sends one sign-out when two start at once, and opens again only after it", async () => {
    const server = holdingFetch();
    const first = logout();
    const second = logout(true);
    // The second does not open the way early: the first sign-out is not over yet.
    expect(isSessionEnded(await settle(request("GET", "/api/x")))).toBe(true);
    server.answer();
    await Promise.all([first, second]);
    expect(
      server.fetchMock.mock.calls.filter((call) => call[0].startsWith("/api/auth/logout")),
    ).toHaveLength(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    await expect(request("GET", "/api/x")).resolves.toEqual({});
  });

  it("lets requests go out again when signing out failed", async () => {
    const then = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/auth/logout"
          ? new Response('{"error":{"code":"internal","message":"x"}}', { status: 500 })
          : new Response("{}", { status: 200 }),
      ),
    );
    expect((await failure(logout(false, then))).code).toBe("internal");
    expect(then).not.toHaveBeenCalled();
    await expect(request("GET", "/api/orgs/o/roles")).resolves.toEqual({});
  });

  it("lets go of the session signal once a request is over", async () => {
    const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    respond(200, "{}");
    await request("GET", "/api/x");
    const forwarders = added.mock.calls.filter((call) => call[0] === "abort").map((c) => c[1]);
    const released = removed.mock.calls.filter((call) => call[0] === "abort").map((c) => c[1]);
    expect(forwarders.length).toBeGreaterThan(0);
    expect(released).toEqual(forwarders);
    added.mockRestore();
    removed.mockRestore();
  });
});

describe("errorFromResponse", () => {
  it("ignores a malformed envelope", () => {
    expect(errorFromResponse(403, { error: "nope" }).code).toBe("forbidden");
    expect(errorFromResponse(500, null).code).toBe("internal");
    expect(errorFromResponse(404, [1, 2]).code).toBe("not_found");
  });
});

describe("auth responses", () => {
  const me = {
    id: "u1",
    email: "a@example.com",
    name: "A",
    isServerAdmin: false,
    orgs: [{ id: "o1", name: "Org", role: "viewer" }],
  };

  it("accepts the documented Me shape", () => {
    expect(isMe(me)).toBe(true);
  });

  it("accepts a custom role name", () => {
    expect(isMe({ ...me, orgs: [{ id: "o1", name: "Org", role: "data-steward" }] })).toBe(true);
  });

  it("rejects a Me with a malformed role or missing fields", () => {
    expect(isMe({ ...me, orgs: [{ id: "o1", name: "Org", role: 3 }] })).toBe(false);
    expect(isMe({ ...me, isServerAdmin: "yes" })).toBe(false);
    expect(isMe({ id: "u1" })).toBe(false);
  });

  it("treats 401 on /api/me as signed out, not as an error", async () => {
    respond(401, '{"error":{"code":"unauthenticated","message":""}}');
    await expect(fetchMe()).resolves.toBeNull();
  });

  it("still fails /api/me for other errors", async () => {
    respond(500, '{"error":{"code":"internal","message":""}}');
    expect((await failure(fetchMe())).code).toBe("internal");
  });

  it("fails loudly when login answers outside the contract", async () => {
    respond(200, '{"id":"u1"}');
    expect((await failure(login({ email: "a@example.com", password: "x" }))).code).toBe(
      "invalid_response",
    );
  });
});
