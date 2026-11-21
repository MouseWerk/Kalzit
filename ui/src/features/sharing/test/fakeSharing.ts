import {
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";

/**
 * The sharing routes of docs/api/sharing.md for tests: public links and snapshots of an
 * organization with create, change expiry and revoke, a snapshot's view, and the routes for
 * visitors with their one neutral refusal. The server has its own tests; this is close enough
 * for the UI.
 */

export interface FakeSharingState {
  /** `sharing.public_enabled`. */
  serverPublic: boolean;
  /** `sharing.org_public_enabled`. */
  orgPublic: boolean;
  maxExpiryDays: number;
  snapshotMaxBytes: number;
  /** Whether `GET /orgs/{orgId}/sharing` exists; false answers 404, as a server before it. */
  limitsRoute: boolean;
  /** The server's clock minus the browser's, in ms: a browser whose clock is off. */
  clockOffsetMs: number;
  /** Panel queries to refuse with `sharing.window_exceeded` before answering, whatever the range. */
  refuseWindow: number;
  /** Panel queries to refuse with `429 sharing.busy` (Retry-After 1 s) before answering. */
  busy: number;
  links: Record<string, unknown>[];
  snapshots: Record<string, unknown>[];
  /** What visitors get per token; a token not listed here does not work. */
  publicLinks: Record<string, Record<string, unknown>>;
  publicSnapshots: Record<string, Record<string, unknown>>;
  /** `GET /snapshots/{id}` by id. */
  snapshotViews: Record<string, Record<string, unknown>>;
  /** What a visitor's panel query answers, by panel id; absent answers no rows. */
  panelAnswers: Record<string, unknown>;
  /** The bodies of create and change requests, for checking what was sent. */
  requests: { method: string; route: string; body: Record<string, unknown> }[];
}

const DAY = 86_400_000;
export const FAKE_TOKEN = "q7Hk2W9mZrT4xLc8q7Hk2W9mZrT4xLc8q7Hk2W9mZrT";

/** A public link as the server lists it. */
export function fakeLink(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id: "l1",
    dashboardId: "d-main",
    dashboardTitle: "Main",
    createdBy: "u1",
    createdByName: "Ada Lovelace",
    createdAt: now - DAY,
    expiresAt: now + 29 * DAY,
    maxWindowMs: 7 * DAY,
    timeRange: { from: "now-24h", to: "now" },
    variables: {},
    views: 3,
    lastViewedAt: null,
    revokedAt: null,
    status: "active",
    ...patch,
  };
}

/** A snapshot as the server lists it. */
export function fakeSnapshot(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id: "s1",
    dashboardId: "d-main",
    dashboardTitle: "Main",
    title: "Main, today",
    public: false,
    createdBy: "u1",
    createdByName: "Ada Lovelace",
    createdAt: now - DAY,
    expiresAt: now + 29 * DAY,
    timeRange: { from: now - DAY, to: now },
    sizeBytes: 1_600_000,
    views: 1,
    lastViewedAt: null,
    revokedAt: null,
    status: "active",
    ...patch,
  };
}

/** A shared dashboard with one table panel, as visitors and snapshot readers get it. */
export function fakePublicDashboard(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Main",
    variables: [{ name: "region", type: "custom", label: "Region", value: "Nord" }],
    rows: [],
    panels: [
      {
        id: "p1",
        type: "table",
        title: "Orders",
        grid: { x: 0, y: 0, w: 12, h: 8 },
        transparent: false,
        targets: [{ refId: "A", hide: false }],
        options: {},
        fieldConfig: {},
      },
    ],
    ...patch,
  };
}

export const FAKE_ANSWER = {
  results: {
    A: {
      result: {
        shape: "frame",
        frame: { fields: [{ name: "customer", type: "string", values: ["Krause", "Lindner"] }] },
      },
    },
  },
};

function refusal(status: number, code: string, reason: string, params?: Record<string, string>) {
  return json(status, {
    error: {
      code,
      message: `server message for ${reason}`,
      reason,
      ...(params === undefined ? {} : { params }),
    },
  });
}

export function sharingFake(_areas: FakeAreaStates): FakeArea<FakeSharingState> {
  const state: FakeSharingState = {
    serverPublic: true,
    orgPublic: true,
    maxExpiryDays: 365,
    snapshotMaxBytes: 10 * 1024 * 1024,
    limitsRoute: true,
    clockOffsetMs: 0,
    refuseWindow: 0,
    busy: 0,
    links: [],
    snapshots: [],
    publicLinks: {},
    publicSnapshots: {},
    snapshotViews: {},
    panelAnswers: {},
    requests: [],
  };

  function list(items: Record<string, unknown>[], request: FakeRequest): Response {
    const dashboardId = request.search.get("dashboardId");
    const mine = request.search.get("mine") === "true";
    // Organization admins see everyone's; everyone else their own.
    const own = mine || !request.permissions.has("org:write");
    return json(200, {
      items: items
        .filter((item) => dashboardId === null || item.dashboardId === dashboardId)
        .filter((item) => !own || item.createdBy === "u1"),
      nextCursor: null,
    });
  }

  function expiryProblem(body: Record<string, unknown>): Response | undefined {
    const expiresAt = Number(body.expiresAt);
    if (body.expiresAt !== undefined && expiresAt > Date.now() + state.maxExpiryDays * DAY) {
      return refusal(422, "validation", "sharing.expiry_invalid", {
        maxDays: String(state.maxExpiryDays),
      });
    }
    return undefined;
  }

  function handle(request: FakeRequest): Response | undefined {
    const { method, route, body } = request;
    const tail = route.replace(/^\/api\/orgs\/[^/]+/, "");
    if (tail === "/sharing" && method === "GET") {
      if (!state.limitsRoute) {
        return json(404, { error: { code: "not_found", message: "not found" } });
      }
      return json(200, {
        serverPublic: state.serverPublic,
        orgPublic: state.orgPublic,
        maxExpiryDays: state.maxExpiryDays,
        snapshotMaxBytes: state.snapshotMaxBytes,
      });
    }
    const created = /^\/dashboards\/([^/]+)\/(public-links|snapshots)$/.exec(tail);
    if (created !== null && method === "POST") {
      const [, dashboardId = "", kind] = created;
      state.requests.push({ method, route, body });
      const isPublic = kind === "public-links" || body.public === true;
      if (isPublic && !request.permissions.has("dashboards:public")) {
        return json(403, { error: { code: "forbidden", message: "forbidden" } });
      }
      if (isPublic && !(state.serverPublic && state.orgPublic)) {
        return refusal(409, "conflict", "sharing.public_off");
      }
      const problem = expiryProblem(body);
      if (problem !== undefined) return problem;
      if (kind === "public-links") {
        const link = fakeLink({
          id: `l${state.links.length + 1}`,
          dashboardId,
          createdAt: Date.now(),
          views: 0,
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          ...(body.maxWindowMs === undefined ? {} : { maxWindowMs: body.maxWindowMs }),
          ...(body.variables === undefined ? {} : { variables: body.variables }),
        });
        state.links.unshift(link);
        return json(201, { link, token: FAKE_TOKEN });
      }
      const snapshot = fakeSnapshot({
        id: `s${state.snapshots.length + 1}`,
        dashboardId,
        createdAt: Date.now(),
        views: 0,
        title: body.title ?? "Main",
        public: body.public === true,
        timeRange: body.timeRange,
      });
      state.snapshots.unshift(snapshot);
      return json(201, body.public === true ? { snapshot, token: FAKE_TOKEN } : { snapshot });
    }
    if (tail === "/public-links" && method === "GET") return list(state.links, request);
    if (tail === "/snapshots" && method === "GET") return list(state.snapshots, request);
    const one = /^\/(public-links|snapshots)\/([^/]+)(\/revoke)?$/.exec(tail);
    if (one !== null) {
      const [, kind, id, revoke] = one;
      const items = kind === "public-links" ? state.links : state.snapshots;
      const item = items.find((candidate) => candidate.id === id);
      if (method === "GET" && kind === "snapshots" && revoke === undefined) {
        const view = state.snapshotViews[id ?? ""];
        return view === undefined
          ? json(404, { error: { code: "not_found", message: "not found" } })
          : json(200, view);
      }
      if (item === undefined) {
        return json(404, { error: { code: "not_found", message: "not found" } });
      }
      state.requests.push({ method, route, body });
      if (revoke !== undefined && method === "POST") {
        if (item.status === "revoked") return refusal(409, "conflict", "sharing.revoked");
        item.status = "revoked";
        item.revokedAt = Date.now();
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        const problem = expiryProblem(body);
        if (problem !== undefined) return problem;
        item.expiresAt = body.expiresAt;
        return json(200, item);
      }
    }
    return undefined;
  }

  return { state, handle };
}

/** How far a visitor's range may lie outside the window at either end, as on the server. */
const CLOCK_SLACK_MS = 60_000;

/** The routes for visitors (`/api/public/...`): no session, one neutral refusal. */
export function handleSharingPublicRoute(
  state: FakeSharingState,
  path: string,
  method: string,
  body: unknown,
): Response | undefined {
  if (!path.startsWith("/api/public/")) {
    return undefined;
  }
  const unavailable = () => refusal(404, "not_found", "sharing.unavailable");
  const link = /^\/api\/public\/dashboards\/([^/]+)$/.exec(path);
  if (link !== null && method === "GET") {
    const view = state.publicLinks[link[1] ?? ""];
    // The server names its clock; the page counts the window from it.
    return view === undefined
      ? unavailable()
      : json(200, { ...view, now: Date.now() + state.clockOffsetMs });
  }
  const panel = /^\/api\/public\/dashboards\/([^/]+)\/panels\/([^/]+)\/query$/.exec(path);
  if (panel !== null && method === "POST") {
    const view = state.publicLinks[panel[1] ?? ""];
    if (view === undefined) return unavailable();
    // The window, counted from the server's clock when the request arrives.
    const range = (body as { timeRange?: { from?: unknown; to?: unknown } } | undefined)?.timeRange;
    const from = Number(range?.from);
    const to = Number(range?.to);
    const now = Date.now() + state.clockOffsetMs;
    const window = Number(view.maxWindowMs);
    const outside =
      !(from < to) || from < now - window - CLOCK_SLACK_MS || to > now + CLOCK_SLACK_MS;
    if (outside || state.refuseWindow > 0) {
      state.refuseWindow = Math.max(0, state.refuseWindow - 1);
      return refusal(422, "validation", "sharing.window_exceeded", {
        maxWindowMs: String(window),
      });
    }
    if (state.busy > 0) {
      state.busy -= 1;
      return new Response(
        JSON.stringify({
          error: {
            code: "rate_limited",
            message: "server message for sharing.busy",
            reason: "sharing.busy",
            retryAfterSecs: 1,
          },
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
      );
    }
    return json(200, state.panelAnswers[panel[2] ?? ""] ?? FAKE_ANSWER);
  }
  const snapshot = /^\/api\/public\/snapshots\/([^/]+)$/.exec(path);
  if (snapshot !== null && method === "GET") {
    const view = state.publicSnapshots[snapshot[1] ?? ""];
    return view === undefined ? unavailable() : json(200, view);
  }
  return unavailable();
}
