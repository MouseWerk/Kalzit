import { vi } from "vitest";
import type { Me } from "../api/auth";
import type { Permission } from "../api/generated/shapes";
import { dashboardsFake } from "../features/dashboards/test/fakeDashboards";
import { datasourcesFake } from "../features/datasources/test/fakeDatasources";

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
const EDIT_PERMISSIONS: Permission[] = [
  "dashboards:write",
  "dashboards:delete",
  "folders:write",
  "datasources:query",
  "datasources:read",
];
const DATA_ADMIN_PERMISSIONS: Permission[] = [
  "datasources:write",
  "datasources:permissions",
  "folders:permissions",
];
export const BUILT_IN_ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [
    ...ADMIN_PERMISSIONS,
    ...READ_PERMISSIONS,
    ...EDIT_PERMISSIONS,
    ...DATA_ADMIN_PERMISSIONS,
    "org:delete",
  ],
  admin: [
    ...ADMIN_PERMISSIONS,
    ...READ_PERMISSIONS,
    ...EDIT_PERMISSIONS,
    ...DATA_ADMIN_PERMISSIONS,
  ],
  editor: [...READ_PERMISSIONS, ...EDIT_PERMISSIONS, "users:read"],
  viewer: READ_PERMISSIONS,
};

/**
 * What an area's fake routes see of a request. `permissions` are the caller's effective ones in
 * the organization of the path, empty when signed out or not a member.
 */
export interface FakeRequest {
  method: string;
  /** The path without the query string, which is in `search`. */
  route: string;
  search: URLSearchParams;
  body: Record<string, unknown>;
  permissions: ReadonlySet<string>;
}

/** An area's routes: answers a request it owns, or undefined to let the next area try. */
export interface FakeArea<State> {
  state: State;
  handle: (request: FakeRequest) => Response | undefined | Promise<Response | undefined>;
}

/**
 * The fake routes of the feature areas, one line per area (`features/<area>/test/fake*.ts`).
 * Each gets the states of all areas, so the panel query route can run data source queries.
 */
const AREA_FAKES = {
  datasources: datasourcesFake,
  dashboards: dashboardsFake,
};

export type FakeAreaStates = {
  [Name in keyof typeof AREA_FAKES]: ReturnType<(typeof AREA_FAKES)[Name]>["state"];
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
  /** The state of every area's fake routes, for arranging data and checking what was stored. */
  areas: FakeAreaStates;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function error(status: number, code: string, field?: string): Response {
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
  const areaStates = {} as FakeAreaStates;
  const areas = Object.entries(AREA_FAKES).map(([name, create]) => {
    const area: FakeArea<unknown> = create(areaStates);
    (areaStates as Record<string, unknown>)[name] = area.state;
    return area;
  });
  const server: FakeServer = {
    areas: areaStates,
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

  function permissionsOf(role: string): string[] {
    const roles = options.rolePermissions ?? BUILT_IN_ROLE_PERMISSIONS;
    return roles[role] ?? [];
  }

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
      return json(200, { ...membership, permissions: permissionsOf(membership.role) });
    }
    if (path.startsWith("/api/orgs/")) {
      if (!state.signedIn) {
        return error(401, "unauthenticated");
      }
      const [route = "", query = ""] = path.split("?");
      const membership = state.user.orgs.find(
        (org) => org.id === decodeURIComponent(route.split("/")[3] ?? ""),
      );
      if (membership === undefined) {
        return error(404, "not_found");
      }
      const request: FakeRequest = {
        method,
        route,
        search: new URLSearchParams(query),
        body: input,
        permissions: new Set(permissionsOf(membership.role)),
      };
      for (const area of areas) {
        const response = await area.handle(request);
        if (response !== undefined) {
          return response;
        }
      }
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
