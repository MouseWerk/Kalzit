import { describe, expect, it, vi } from "vitest";
import { generatedUnion } from "../test/generated";
import { fetchMe, isMe, login } from "./auth";
import { ApiError, errorFromResponse, request, SERVER_ERROR_CODES } from "./client";

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
    });
  });

  it("sends no body and no content type for a GET", async () => {
    const fetchMock = respond(200, '{"needed":false}');
    await request("GET", "/api/setup");
    expect(fetchMock).toHaveBeenCalledWith("/api/setup", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
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
  ] as const)("maps status %i without an envelope to %s", async (status, code) => {
    respond(status, "<html>Bad Gateway</html>", "text/html");
    const error = await failure(request("GET", "/api/x"));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
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

  it("rejects a successful response that is not JSON", async () => {
    respond(200, "<html></html>", "text/html");
    expect((await failure(request("GET", "/api/me"))).code).toBe("invalid_response");
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
