import { vi } from "vitest";
import type { Me } from "../api/auth";
import type { Permission } from "../api/generated/shapes";
import { handleAdminRoute } from "../features/admin/test/fakeAdmin";
import { dashboardFeaturesFake } from "../features/dashboards/test/fakeDashboardFeatures";
import { dashboardsFake } from "../features/dashboards/test/fakeDashboards";
import { datasourcesFake } from "../features/datasources/test/fakeDatasources";
import { shellFake } from "../shell/test/fakeShell";

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
  // Org-internal sharing is an editor right on the server (authz.rs).
  "dashboards:share",
  "folders:write",
  "datasources:query",
  "datasources:read",
  "data:export",
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
  // Before dashboards: it answers /dashboards/validate and the annotation routes.
  dashboardFeatures: dashboardFeaturesFake,
  dashboards: dashboardsFake,
  shell: shellFake,
};

export type FakeAreaStates = {
  [Name in keyof typeof AREA_FAKES]: ReturnType<(typeof AREA_FAKES)[Name]>["state"];
};

/** Stored preferences; `null` follows the defaults, as on the server (docs/api/shell.md). */
export interface FakePreferences {
  language: string | null;
  theme: string | null;
  timeZone: string | null;
  weekStart: string | null;
  startDashboard: { orgId: string; dashboardId: string } | null;
  /** The server defaults (`appearance.*`); English here, so tests read English. */
  defaults: { language: string; theme: string };
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
  state: {
    setupNeeded: boolean;
    signedIn: boolean;
    user: Me;
    offline: boolean;
    /** The stored preferences (`/api/me/preferences`), as the server keeps them. */
    preferences: FakePreferences;
    /** `GET /api/branding`, before and after sign-in (docs/api/settings-dashboards.md). */
    branding: Record<string, unknown>;
    /** `GET /api/orgs/{orgId}/appearance` for every organization. */
    appearance: Record<string, unknown>;
  };
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
      preferences: {
        // A user who already chose English, so signing in adopts nothing unless a test says so.
        language: "en",
        theme: null,
        timeZone: null,
        weekStart: null,
        startDashboard: null,
        defaults: { language: "en", theme: "system" },
      },
      branding: {
        productName: "Kalzit",
        logo: null,
        signIn: { welcome: "", notice: "" },
        defaultTheme: "system",
        accent: "copper",
        density: "balanced",
        fontSize: 14,
      },
      appearance: {
        accent: "copper",
        density: "balanced",
        fontSize: 14,
        startPage: "home",
        timeZone: "browser",
        weekStart: "monday",
      },
    },
    calls: [],
    failNext: (path, status, code, method, field) =>
      failures.set(path, { status, code, method, field }),
  };

  function permissionsOf(role: string): string[] {
    const roles = options.rolePermissions ?? BUILT_IN_ROLE_PERMISSIONS;
    return roles[role] ?? [];
  }

  /** The preferences route: patch semantics and the documented checks. */
  function preferences(method: string, input: Record<string, unknown>): Response {
    const stored = server.state.preferences;
    if (method === "PATCH") {
      const allowed: Record<string, readonly string[] | null> = {
        language: ["de", "en"],
        theme: ["system", "light", "dark", "contrast"],
        weekStart: ["monday", "sunday", "saturday"],
        timeZone: null,
        startDashboard: null,
      };
      for (const [key, value] of Object.entries(input)) {
        if (!(key in allowed)) {
          return error(422, "validation", key);
        }
        const options = allowed[key];
        if (value !== null && options != null && !options.includes(String(value))) {
          return error(422, "validation", key);
        }
        if (
          key === "timeZone" &&
          value !== null &&
          !/^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(String(value))
        ) {
          return error(422, "validation", key);
        }
      }
      const start = input.startDashboard as
        | { orgId?: string; dashboardId?: string }
        | null
        | undefined;
      if (start != null) {
        const found = areaStates.dashboards.dashboards.find(
          (d) => d.id === start.dashboardId && d.deletedAt === null,
        );
        if (found === undefined || !server.state.user.orgs.some((o) => o.id === start.orgId)) {
          return error(422, "validation", "startDashboard");
        }
      }
      Object.assign(stored, input);
    }
    const start = stored.startDashboard;
    const dashboard =
      start === null
        ? undefined
        : areaStates.dashboards.dashboards.find(
            (d) => d.id === start.dashboardId && d.deletedAt === null,
          );
    return json(200, {
      ...stored,
      startDashboard:
        start === null || dashboard === undefined
          ? null
          : { ...start, title: dashboard.versions.at(-1)?.model.title ?? "" },
    });
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
    if (path === "/api/me/preferences" && (method === "GET" || method === "PATCH")) {
      if (!state.signedIn) {
        return error(401, "unauthenticated");
      }
      return preferences(method, input);
    }
    if (path === "/api/branding" && method === "GET") {
      return json(200, state.branding);
    }
    if (path === "/api/about" && method === "GET") {
      if (!state.signedIn) {
        return error(401, "unauthenticated");
      }
      return json(200, {
        version: "0.1.0",
        commit: "a1b2c3d4e",
        buildDate: "2026-10-25",
        platform: "linux",
        arch: "x64",
        database: "sqlite",
      });
    }
    // The list the build writes into the bundle (ui/scripts/licenses.mjs).
    if (path === "/third-party-licenses.json" && method === "GET") {
      return json(200, [
        { name: "axum", version: "0.8.9", license: "MIT", source: "rust" },
        { name: "sqlx", version: "0.9.0", license: "MIT OR Apache-2.0", source: "rust" },
        { name: "react", version: "19.3.1", license: "MIT", source: "npm" },
      ]);
    }
    if (path.startsWith("/api/admin/branding/logo") && state.signedIn && state.user.isServerAdmin) {
      // The logo and the one before it, which undo swaps back (docs/api/settings-dashboards.md).
      const current = state.branding.logo ?? null;
      if (path === "/api/admin/branding/logo" && method === "PUT") {
        const logo = {
          contentType: String(input.contentType),
          sha256: `sha${server.calls.length}`,
        };
        Object.assign(state, { previousLogo: current });
        state.branding.logo = logo;
        return json(200, logo);
      }
      if (path === "/api/admin/branding/logo" && method === "DELETE") {
        if (current === null) {
          return error(404, "not_found");
        }
        Object.assign(state, { previousLogo: current });
        state.branding.logo = null;
        return new Response(null, { status: 204 });
      }
      if (path === "/api/admin/branding/logo/restore" && method === "POST") {
        const previous = (state as { previousLogo?: unknown }).previousLogo ?? null;
        Object.assign(state, { previousLogo: current });
        state.branding.logo = previous;
        return json(200, previous);
      }
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
      if (route.endsWith("/appearance") && route.split("/").length === 5 && method === "GET") {
        return json(200, state.appearance);
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
