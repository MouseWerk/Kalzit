import { vi } from "vitest";
import type { Me } from "../api/auth";
import type { Permission } from "../api/generated/shapes";
import { handleAdminRoute } from "../features/admin/test/fakeAdmin";

/**
 * An in-memory stand-in for the Kalzit server's auth routes, installed as the global fetch.
 * It follows the server contract (status codes, error envelope, cookie session) closely enough
 * for the UI's guards and forms; the real server is covered by its own tests and the e2e suite.
 */
export interface FakeServerOptions {
  setupNeeded?: boolean;
  signedIn?: boolean;
  user?: Me;
  password?: string;
  setupToken?: string;
  /** Permissions per role name; defaults follow the built-in roles in docs/ARCHITECTURE.md. */
  rolePermissions?: Record<string, string[]>;
}

// A representative excerpt of the built-in roles, enough for what the UI decides on.
// Editors hold users:read so they can pick people to share with; that must not open the
// administration.
const ADMIN_PERMISSIONS: Permission[] = [
  "users:read",
  "users:write",
  "roles:read",
  "roles:write",
  "audit:read",
  "settings:read",
  "settings:write",
];
const READ_PERMISSIONS: Permission[] = ["dashboards:read", "folders:read", "analyses:read"];
export const BUILT_IN_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [...ADMIN_PERMISSIONS, ...READ_PERMISSIONS, "org:delete"],
  admin: [...ADMIN_PERMISSIONS, ...READ_PERMISSIONS],
  editor: [...READ_PERMISSIONS, "dashboards:write", "datasources:query", "users:read"],
  viewer: READ_PERMISSIONS,
};

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
  failNext: (path: string, status: number, code: string, method?: string, field?: string) => void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, code: string, field?: string): Response {
  const message = `server message for ${code}`;
  return json(status, {
    error: field === undefined ? { code, message } : { code, message, field },
  });
}

export function installFakeServer(options: FakeServerOptions = {}): FakeServer {
  const password = options.password ?? TEST_PASSWORD;
  const setupToken = options.setupToken ?? TEST_SETUP_TOKEN;
  const failures = new Map<
    string,
    { status: number; code: string; method?: string | undefined; field?: string | undefined }
  >();
  const server: FakeServer = {
    state: {
      setupNeeded: options.setupNeeded ?? false,
      signedIn: options.signedIn ?? false,
      user: options.user ?? TEST_USER,
      offline: false,
    },
    calls: [],
    failNext: (path, status, code, method, field) =>
      failures.set(path, { status, code, method, field }),
  };

  async function handle(path: string, method: string, body: unknown): Promise<Response> {
    const failure = failures.get(path);
    if (failure !== undefined && (failure.method === undefined || failure.method === method)) {
      failures.delete(path);
      return error(failure.status, failure.code, failure.field);
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
    const orgPath = /^\/api\/orgs\/([^/]+)$/.exec(path);
    if (orgPath !== null && method === "GET") {
      if (!state.signedIn) {
        return error(401, "unauthenticated");
      }
      // Not a member answers not_found, as the server does, so ids cannot be probed.
      const membership = state.user.orgs.find(
        (org) => org.id === decodeURIComponent(orgPath[1] ?? ""),
      );
      if (membership === undefined) {
        return error(404, "not_found");
      }
      const roles = options.rolePermissions ?? BUILT_IN_ROLE_PERMISSIONS;
      return json(200, { ...membership, permissions: roles[membership.role] ?? [] });
    }
    return handleAdminRoute(server, path, method, body) ?? error(404, "not_found");
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
