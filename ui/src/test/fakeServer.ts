import { vi } from "vitest";
import type { Me } from "../api/auth";

/**
 * An in-memory stand-in for the Granit server's auth routes, installed as the global fetch.
 * It follows the server contract (status codes, error envelope, cookie session) closely enough
 * for the UI's guards and forms; the real server is covered by its own tests and the e2e suite.
 */
export interface FakeServerOptions {
  setupNeeded?: boolean;
  signedIn?: boolean;
  user?: Me;
  password?: string;
  setupToken?: string;
}

export const TEST_USER: Me = {
  id: "u1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  isServerAdmin: true,
  orgs: [{ id: "o1", name: "Analytical Engines", role: "owner" }],
};

export const TEST_PASSWORD = "correct horse battery";
export const TEST_SETUP_TOKEN = "setup-token-for-tests";

export interface FakeServer {
  /** `offline` makes every request fail the way fetch does when nothing answers. */
  state: { setupNeeded: boolean; signedIn: boolean; user: Me; offline: boolean };
  calls: { method: string; path: string; body: unknown }[];
  /** Makes the next request to `path` (with `method`, if given) answer with this error. */
  failNext: (path: string, status: number, code: string, method?: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, code: string): Response {
  return json(status, { error: { code, message: `server message for ${code}` } });
}

export function installFakeServer(options: FakeServerOptions = {}): FakeServer {
  const password = options.password ?? TEST_PASSWORD;
  const setupToken = options.setupToken ?? TEST_SETUP_TOKEN;
  const failures = new Map<string, { status: number; code: string; method?: string }>();
  const server: FakeServer = {
    state: {
      setupNeeded: options.setupNeeded ?? false,
      signedIn: options.signedIn ?? false,
      user: options.user ?? TEST_USER,
      offline: false,
    },
    calls: [],
    failNext: (path, status, code, method) =>
      failures.set(path, method === undefined ? { status, code } : { status, code, method }),
  };

  async function handle(path: string, method: string, body: unknown): Promise<Response> {
    const failure = failures.get(path);
    if (failure !== undefined && (failure.method === undefined || failure.method === method)) {
      failures.delete(path);
      return error(failure.status, failure.code);
    }
    const { state } = server;
    const input = (body ?? {}) as Record<string, unknown>;

    if (path === "/api/setup" && method === "GET") {
      return json(200, { needed: state.setupNeeded });
    }
    if (path === "/api/setup" && method === "POST") {
      if (!state.setupNeeded) {
        return error(409, "setup_done");
      }
      if (input.token !== setupToken) {
        return error(403, "invalid_setup_token");
      }
      if (typeof input.password !== "string" || Array.from(input.password).length < 12) {
        return error(400, "validation");
      }
      state.setupNeeded = false;
      state.signedIn = true;
      state.user = {
        ...state.user,
        name: String(input.name),
        email: String(input.email),
        orgs: [{ id: "o1", name: String(input.orgName), role: "owner" }],
      };
      return json(200, state.user);
    }
    if (path === "/api/auth/login" && method === "POST") {
      if (input.email !== state.user.email || input.password !== password) {
        return error(401, "invalid_credentials");
      }
      state.signedIn = true;
      return json(200, state.user);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      state.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/api/me" && method === "GET") {
      return state.signedIn ? json(200, state.user) : error(401, "unauthenticated");
    }
    return error(404, "not_found");
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      server.calls.push({ method, path, body });
      if (server.state.offline) {
        throw new TypeError("Failed to fetch");
      }
      return handle(path, method, body);
    }),
  );
  return server;
}
