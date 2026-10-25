import type { FakeServer } from "../../../test/fakeServer";
import { TEST_PASSWORD } from "../../../test/fakeServer";

/**
 * The administration routes of the fake server (test/fakeServer.ts registers them), written from
 * the server's API documents (docs/api/access.md and docs/api/settings-dashboards.md on the
 * server branches), not from the UI's own types: the wire shapes below are declared here on
 * purpose, so a UI that drifts from the server fails these tests.
 *
 * Modelled: `Page<T>` lists with `limit` and `cursor`, request bodies and query strings that
 * reject unknown fields (`422 validation`), route permissions (`403`, from `callerPermissions`),
 * "nobody gives or takes more than they hold", the last owner and last active server admin
 * (`409 conflict`), the custom role limit, versioned settings with `version_conflict` and
 * `current`, and the audit action names the server writes.
 */

interface WireMember {
  userId: string;
  email: string;
  name: string;
  role: string;
  joinedAt: number;
}

interface WireTeamMember {
  userId: string;
  email: string;
  name: string;
  role: "member" | "maintainer";
  addedAt: number;
}

interface WireTeam {
  id: string;
  name: string;
  roles: string[];
  memberCount: number;
  createdAt: number;
}

interface WireRole {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  createdAt: number | null;
}

interface WireGrant {
  id: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  resourceType: string;
  resourceId: string;
  level: string;
  createdAt: number;
}

interface WireSetting {
  key: string;
  scope: "server" | "org";
  value: unknown;
  default: unknown;
  source: "env" | "file" | "database" | "default";
  editable: boolean;
  version: number;
  description: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

interface WireAuditEvent {
  id: string;
  orgId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorAddress: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  summary: Record<string, unknown>;
  createdAt: number;
}

interface WireAdminUser {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

interface WireAdminOrg {
  id: string;
  name: string;
  memberCount: number;
  createdAt: number;
}

interface WireSession {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

type WireExplainSource = Record<string, unknown> & { kind: string };

export interface FakeAdminState {
  /** What the signed-in member holds in the organization; every permission by default. */
  callerPermissions: Set<string>;
  /** Whether the caller manages access to every resource (from a role or an admin grant). */
  managesResources: boolean;
  members: WireMember[];
  teams: (WireTeam & { members: WireTeamMember[] })[];
  roles: WireRole[];
  grants: WireGrant[];
  explain: WireExplainSource[];
  orgSettings: WireSetting[];
  audit: WireAuditEvent[];
  users: WireAdminUser[];
  orgs: WireAdminOrg[];
  serverSettings: WireSetting[];
  sessions: WireSession[];
  password: string;
  /** Items per list page when the request names no limit; tests lower it to exercise paging. */
  pageSize: number;
}

const DAY = 86_400_000;
// A fixed point in time (2026-03-01), so dates in tests do not depend on the clock.
const T0 = Date.UTC(2026, 2, 1);

// The catalog and the built-in roles as the server pins them (server/src/authz.rs).
const ALL_PERMISSIONS = [
  "dashboards:read",
  "dashboards:write",
  "dashboards:delete",
  "dashboards:share",
  "folders:read",
  "folders:write",
  "folders:permissions",
  "datasources:query",
  "datasources:read",
  "datasources:write",
  "datasources:permissions",
  "analyses:read",
  "analyses:write",
  "data:export",
  "annotations:write",
  "teams:read",
  "teams:write",
  "teams:members",
  "users:read",
  "users:invite",
  "users:write",
  "roles:read",
  "roles:write",
  "serviceaccounts:write",
  "audit:read",
  "plugins:configure",
  "settings:read",
  "settings:write",
  "org:write",
  "org:delete",
];
const VIEWER = ["dashboards:read", "folders:read", "analyses:read", "teams:read"];
const EDITOR = [
  ...VIEWER,
  "dashboards:write",
  "dashboards:delete",
  "dashboards:share",
  "folders:write",
  "datasources:query",
  "datasources:read",
  "analyses:write",
  "data:export",
  "annotations:write",
  "users:read",
];
const OWNER = ALL_PERMISSIONS;
const ADMIN = ALL_PERMISSIONS.filter((permission) => permission !== "org:delete");

function builtInRole(id: string, permissions: string[]): WireRole {
  return { id, name: id, description: "", builtin: true, permissions, createdAt: null };
}

function setting(
  key: string,
  scope: "server" | "org",
  value: unknown,
  extra: Partial<WireSetting> = {},
): WireSetting {
  return {
    key,
    scope,
    value,
    default: value,
    source: "default",
    editable: true,
    version: 0,
    description: `The setting ${key}`,
    updatedAt: null,
    updatedBy: null,
    ...extra,
  };
}

function initialState(server: FakeServer): FakeAdminState {
  const me = server.state.user;
  const orgId = me.orgs[0]?.id ?? null;
  return {
    callerPermissions: new Set(ALL_PERMISSIONS),
    managesResources: true,
    members: [
      { userId: me.id, email: me.email, name: me.name, role: "owner", joinedAt: T0 },
      {
        userId: "u2",
        email: "grace@example.com",
        name: "Grace Hopper",
        role: "editor",
        joinedAt: T0 + DAY,
      },
      {
        userId: "u3",
        email: "alan@example.com",
        name: "Alan Turing",
        role: "viewer",
        joinedAt: T0 + 2 * DAY,
      },
    ],
    teams: [
      {
        id: "t1",
        name: "Analysts",
        roles: [],
        memberCount: 1,
        createdAt: T0,
        members: [
          {
            userId: "u2",
            email: "grace@example.com",
            name: "Grace Hopper",
            role: "maintainer",
            addedAt: T0,
          },
        ],
      },
    ],
    roles: [
      builtInRole("owner", OWNER),
      builtInRole("admin", ADMIN),
      builtInRole("editor", EDITOR),
      builtInRole("viewer", VIEWER),
      {
        id: "r1",
        name: "Auditor",
        description: "Reads the audit log",
        builtin: false,
        permissions: ["audit:read"],
        createdAt: T0,
      },
    ],
    grants: [
      {
        id: "g1",
        subjectType: "team",
        subjectId: "t1",
        subjectName: "Analysts",
        resourceType: "dashboard",
        resourceId: "d1",
        level: "edit",
        createdAt: T0,
      },
    ],
    explain: [
      { kind: "orgRole", role: "owner" },
      { kind: "teamRole", teamId: "t1", teamName: "Analysts", role: "r1", roleName: "Auditor" },
    ],
    orgSettings: [setting("dashboards.default_time_range", "org", { from: "now-6h", to: "now" })],
    audit: [
      {
        id: "a1",
        orgId,
        action: "team.created",
        actorUserId: me.id,
        actorName: me.name,
        actorAddress: "192.0.2.10",
        resourceType: "team",
        resourceId: "t1",
        summary: { teamId: "t1" },
        createdAt: T0 + 3 * DAY,
      },
      {
        id: "a2",
        orgId: null,
        action: "auth.signed_in",
        actorUserId: "u2",
        actorName: "Grace Hopper",
        actorAddress: "192.0.2.11",
        resourceType: null,
        resourceId: null,
        summary: {},
        createdAt: T0 + 2 * DAY,
      },
      {
        id: "a3",
        orgId,
        action: "settings.updated",
        actorUserId: null,
        actorName: null,
        actorAddress: null,
        resourceType: "setting",
        resourceId: "dashboards.default_time_range",
        summary: { key: "dashboards.default_time_range", version: 2 },
        createdAt: T0 + DAY,
      },
      {
        id: "a4",
        orgId,
        action: "plugin.future_action",
        actorUserId: null,
        actorName: null,
        actorAddress: null,
        resourceType: null,
        resourceId: null,
        summary: { fields: ["name", "role"] },
        createdAt: T0,
      },
    ],
    users: [
      {
        id: me.id,
        email: me.email,
        name: me.name,
        isServerAdmin: me.isServerAdmin,
        disabled: false,
        createdAt: T0,
      },
      {
        id: "u2",
        email: "grace@example.com",
        name: "Grace Hopper",
        isServerAdmin: false,
        disabled: false,
        createdAt: T0 + DAY,
      },
      {
        id: "u3",
        email: "alan@example.com",
        name: "Alan Turing",
        isServerAdmin: false,
        disabled: false,
        createdAt: T0 + 2 * DAY,
      },
    ],
    orgs: me.orgs.map((org) => ({ id: org.id, name: org.name, memberCount: 3, createdAt: T0 })),
    serverSettings: [
      setting("audit.retention_days", "server", 365, {
        source: "env",
        editable: false,
        description: "How long audit events are kept",
      }),
      setting("datasources.query_timeout_secs", "server", 30, {
        source: "file",
        editable: false,
      }),
      setting("appearance.default_theme", "server", "system"),
      setting("datasources.max_rows", "server", 100000),
      setting("sessions.lifetime_hours", "server", 720, { editable: false }),
    ],
    sessions: [
      {
        id: "s1",
        createdAt: T0 + 2 * DAY,
        lastSeenAt: T0 + 3 * DAY,
        expiresAt: T0 + 30 * DAY,
        current: true,
      },
      {
        id: "s2",
        createdAt: T0 + DAY,
        lastSeenAt: T0 + DAY,
        expiresAt: T0 + 29 * DAY,
        current: false,
      },
      { id: "s3", createdAt: T0, lastSeenAt: T0, expiresAt: T0 + 28 * DAY, current: false },
    ],
    password: TEST_PASSWORD,
    pageSize: 50,
  };
}

const states = new WeakMap<FakeServer, FakeAdminState>();

/** The administration data of a fake server, created on first use; tests read and change it. */
export function fakeAdmin(server: FakeServer): FakeAdminState {
  let state = states.get(server);
  if (state === undefined) {
    state = initialState(server);
    states.set(server, state);
  }
  return state;
}

// Answers

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, code: string, field?: string, extra: object = {}): Response {
  const message = `server message for ${code}`;
  return json(status, {
    error: field === undefined ? { code, message } : { code, message, field },
    ...extra,
  });
}

const STATUS: Record<string, number> = {
  validation: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  unauthenticated: 401,
};

/** A refusal; thrown inside handlers and turned into the error answer. */
class Refusal {
  constructor(
    readonly code: string,
    readonly field?: string,
    readonly extra: object = {},
  ) {}
}

function refuse(code: string, field?: string, extra?: object): never {
  throw new Refusal(code, field, extra);
}

const noContent = () => new Response(null, { status: 204 });

// Request checks, as the server does them

type Input = Record<string, unknown>;

/** Bodies reject unknown fields and missing required ones. */
function body(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Input {
  const record = (input ?? {}) as Input;
  for (const name of Object.keys(record)) {
    if (!required.includes(name) && !optional.includes(name)) {
      refuse("validation", name);
    }
  }
  for (const name of required) {
    if (record[name] === undefined) {
      refuse("validation", name);
    }
  }
  return record;
}

/** Query strings reject unknown parameters. */
function params(search: URLSearchParams, allowed: readonly string[]): URLSearchParams {
  for (const name of search.keys()) {
    if (!allowed.includes(name)) {
      refuse("validation", name);
    }
  }
  return search;
}

const PAGING = ["limit", "cursor"];

function page<T>(items: readonly T[], search: URLSearchParams, size: number): Response {
  const limitText = search.get("limit");
  const limit = limitText === null ? size : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    refuse("validation", "limit");
  }
  const cursorText = search.get("cursor");
  const start = cursorText === null ? 0 : Number(cursorText);
  if (!Number.isInteger(start) || start < 0) {
    refuse("validation", "cursor");
  }
  const end = start + Math.min(limit, size);
  return json(200, {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  });
}

let nextId = 100;
const newId = (prefix: string) => `${prefix}${nextId++}`;

function needs(state: FakeAdminState, permission: string): void {
  if (!state.callerPermissions.has(permission)) {
    refuse("forbidden");
  }
}

function roleKeyPermissions(state: FakeAdminState, key: string): string[] | undefined {
  return state.roles.find((role) => role.id === key)?.permissions;
}

/** Nobody gives or takes away what they do not hold. */
function holds(state: FakeAdminState, permissions: readonly string[]): void {
  if (!permissions.every((permission) => state.callerPermissions.has(permission))) {
    refuse("forbidden");
  }
}

function holdsRoles(state: FakeAdminState, keys: readonly string[]): void {
  for (const key of keys) {
    holds(state, roleKeyPermissions(state, key) ?? []);
  }
}

function name(value: unknown, field = "name"): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || trimmed.length > 100 || /\p{Cc}/u.test(trimmed)) {
    refuse("validation", field);
  }
  return trimmed;
}

/**
 * Answers an administration route, or undefined when the path is not one of them. Registered in
 * test/fakeServer.ts before its final not_found.
 */
export function handleAdminRoute(
  server: FakeServer,
  rawPath: string,
  method: string,
  input: unknown,
): Response | undefined {
  const url = new URL(rawPath, "http://kalzit.test");
  const path = url.pathname;
  const isOrg = path.startsWith("/api/orgs/") && path.split("/").length > 4;
  const isAdmin = path.startsWith("/api/admin/");
  const isMe = path.startsWith("/api/me") && !(path === "/api/me" && method === "GET");
  if (!isOrg && !isAdmin && !isMe) {
    return undefined;
  }
  if (!server.state.signedIn) {
    return error(401, "unauthenticated");
  }
  const state = fakeAdmin(server);
  try {
    if (isMe) {
      return handleMe(server, state, path, method, input, url.searchParams);
    }
    if (isAdmin) {
      if (!server.state.user.isServerAdmin) {
        return error(403, "forbidden");
      }
      return handleServerAdmin(server, state, path, method, input, url.searchParams);
    }
    const [, , , orgId = "", ...rest] = path.split("/").map(decodeURIComponent);
    if (!server.state.user.orgs.some((org) => org.id === orgId)) {
      return error(404, "not_found");
    }
    return handleOrg(server, state, orgId, rest, method, input, url.searchParams);
  } catch (caught) {
    if (caught instanceof Refusal) {
      return error(STATUS[caught.code] ?? 500, caught.code, caught.field, caught.extra);
    }
    throw caught;
  }
}

function handleMe(
  server: FakeServer,
  state: FakeAdminState,
  path: string,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  if (path === "/api/me" && method === "PATCH") {
    const fields = body(input, ["name"]);
    server.state.user = { ...server.state.user, name: name(fields.name) };
    return json(200, server.state.user);
  }
  if (path === "/api/me/password" && method === "POST") {
    const fields = body(input, ["current", "new"]);
    if (fields.current !== state.password) {
      refuse("validation", "current");
    }
    if (typeof fields.new !== "string" || Array.from(fields.new).length < 12) {
      refuse("validation", "new");
    }
    state.password = fields.new;
    state.sessions = state.sessions.filter((session) => session.current);
    return noContent();
  }
  if (path === "/api/me/sessions" && method === "GET") {
    return page(state.sessions, params(search, PAGING), state.pageSize);
  }
  if (path === "/api/me/sessions/revoke-others" && method === "POST") {
    const revoked = state.sessions.filter((session) => !session.current).length;
    state.sessions = state.sessions.filter((session) => session.current);
    return json(200, { revoked });
  }
  const session = /^\/api\/me\/sessions\/([^/]+)$/.exec(path);
  if (session !== null && method === "DELETE") {
    if (!state.sessions.some((candidate) => candidate.id === session[1])) {
      refuse("not_found");
    }
    state.sessions = state.sessions.filter((candidate) => candidate.id !== session[1]);
    return noContent();
  }
  return refuse("not_found");
}

function owners(state: FakeAdminState): number {
  // Disabled owners do not count (docs/api/access.md, "An enabled owner remains").
  return state.members.filter(
    (member) =>
      member.role === "owner" &&
      state.users.find((user) => user.id === member.userId)?.disabled !== true,
  ).length;
}

function handleOrg(
  server: FakeServer,
  state: FakeAdminState,
  orgId: string,
  rest: string[],
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  const [area, id, sub, subId] = rest;

  if (area === "members") {
    return members(state, id, method, input, search);
  }
  if (area === "teams") {
    return teams(server, state, id, sub, subId, method, input, search);
  }
  if (area === "roles") {
    return roles(state, id, method, input, search);
  }
  if (area === "grants") {
    return grants(state, id, method, input, search);
  }
  if (area === "explain" && id === undefined && method === "GET") {
    params(search, ["permission", "resourceType", "resourceId"]);
    const permission = search.get("permission");
    if (permission === null || !ALL_PERMISSIONS.includes(permission)) {
      refuse("validation", "permission");
    }
    if ((search.get("resourceType") === null) !== (search.get("resourceId") === null)) {
      refuse("validation", "resourceType");
    }
    const sources = state.callerPermissions.has(permission) ? state.explain : [];
    return json(200, { permission, allowed: sources.length > 0, sources });
  }
  if (area === "settings") {
    needs(state, id === undefined ? "settings:read" : "settings:write");
    if (id === undefined && method === "GET") {
      return page(state.orgSettings, params(search, PAGING), state.pageSize);
    }
    return (
      settingsExtras(server, state.orgSettings, "org", id, method, input) ??
      patchSetting(server, state.orgSettings, id, method, input)
    );
  }
  if (area === "audit" && id === undefined && method === "GET") {
    needs(state, "audit:read");
    return audit(
      state.audit.filter((event) => event.orgId === orgId),
      search,
      state.pageSize,
      false,
    );
  }
  return refuse("not_found");
}

function members(
  state: FakeAdminState,
  id: string | undefined,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  if (id === undefined && method === "GET") {
    needs(state, "users:read");
    return page(state.members, params(search, PAGING), state.pageSize);
  }
  needs(state, "users:write");
  if (id === undefined && method === "POST") {
    const fields = body(input, ["email", "role"]);
    const email = String(fields.email).trim().toLowerCase();
    const user = state.users.find((candidate) => candidate.email === email);
    if (!email.includes("@") || user === undefined) {
      refuse("validation", "email");
    }
    const permissions = roleKeyPermissions(state, String(fields.role));
    if (permissions === undefined) {
      refuse("validation", "role");
    }
    if (state.members.some((member) => member.userId === user.id)) {
      refuse("conflict", "email");
    }
    holds(state, permissions);
    const member = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: String(fields.role),
      joinedAt: T0 + 10 * DAY,
    };
    state.members.push(member);
    return json(201, member);
  }
  const member = state.members.find((candidate) => candidate.userId === id);
  if (member === undefined) {
    refuse("not_found");
  }
  holds(state, roleKeyPermissions(state, member.role) ?? ALL_PERMISSIONS);
  const lastOwner = member.role === "owner" && owners(state) === 1;
  if (method === "PATCH") {
    const fields = body(input, ["role"]);
    const permissions = roleKeyPermissions(state, String(fields.role));
    if (permissions === undefined) {
      refuse("validation", "role");
    }
    holds(state, permissions);
    if (lastOwner && fields.role !== "owner") {
      refuse("conflict");
    }
    member.role = String(fields.role);
    return json(200, member);
  }
  if (method === "DELETE") {
    if (lastOwner) {
      refuse("conflict");
    }
    state.members = state.members.filter((candidate) => candidate !== member);
    return noContent();
  }
  return refuse("not_found");
}

function teamView(team: FakeAdminState["teams"][number]): WireTeam {
  const { members: _members, ...view } = team;
  return { ...view, memberCount: team.members.length };
}

function teams(
  server: FakeServer,
  state: FakeAdminState,
  id: string | undefined,
  sub: string | undefined,
  subId: string | undefined,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  if (id === undefined && method === "GET") {
    needs(state, "teams:read");
    return page(state.teams.map(teamView), params(search, PAGING), state.pageSize);
  }
  if (id === undefined && method === "POST") {
    needs(state, "teams:write");
    const teamName = name(body(input, ["name"]).name);
    if (state.teams.some((team) => team.name.toLowerCase() === teamName.toLowerCase())) {
      refuse("conflict", "name");
    }
    const team = {
      id: newId("t"),
      name: teamName,
      roles: [],
      memberCount: 0,
      createdAt: T0,
      members: [],
    };
    state.teams.push(team);
    return json(201, teamView(team));
  }
  const team = state.teams.find((candidate) => candidate.id === id);
  if (team === undefined) {
    refuse("not_found");
  }
  if (sub === undefined) {
    if (method === "GET") {
      needs(state, "teams:read");
      return json(200, teamView(team));
    }
    needs(state, "teams:write");
    if (method === "PATCH") {
      const teamName = name(body(input, ["name"]).name);
      if (
        state.teams.some(
          (other) => other !== team && other.name.toLowerCase() === teamName.toLowerCase(),
        )
      ) {
        refuse("conflict", "name");
      }
      team.name = teamName;
      return json(200, teamView(team));
    }
    if (method === "DELETE") {
      holdsRoles(state, team.roles);
      state.teams = state.teams.filter((candidate) => candidate !== team);
      return noContent();
    }
  }
  if (sub === "roles" && method === "PUT") {
    needs(state, "teams:write");
    const roles = body(input, ["roles"]).roles;
    if (!Array.isArray(roles)) {
      refuse("validation", "roles");
    }
    const next = [...new Set(roles.map(String))].sort();
    if (
      next.length > 20 ||
      next.some((key) => key === "owner" || roleKeyPermissions(state, key) === undefined)
    ) {
      refuse("validation", "roles");
    }
    holdsRoles(state, [...team.roles, ...next]);
    team.roles = next;
    return json(200, teamView(team));
  }
  if (sub === "members") {
    if (subId === undefined && method === "GET") {
      needs(state, "teams:read");
      return page(team.members, params(search, PAGING), state.pageSize);
    }
    const caller = server.state.user.id;
    const maintainer = team.members.some(
      (member) => member.userId === caller && member.role === "maintainer",
    );
    if (!state.callerPermissions.has("teams:members") && !maintainer) {
      refuse("forbidden");
    }
    holdsRoles(state, team.roles);
    if (method === "PUT") {
      const fields = body(input, [], ["role"]);
      const role = fields.role ?? "member";
      if (role !== "member" && role !== "maintainer") {
        refuse("validation", "role");
      }
      const existing = team.members.find((member) => member.userId === subId);
      if (existing !== undefined) {
        existing.role = role;
        return json(200, existing);
      }
      const member = state.members.find((candidate) => candidate.userId === subId);
      if (member === undefined) {
        refuse("not_found");
      }
      const added = {
        userId: member.userId,
        email: member.email,
        name: member.name,
        role,
        addedAt: T0 + 10 * DAY,
      } as const;
      team.members.push(added);
      return json(200, added);
    }
    if (method === "DELETE") {
      if (!team.members.some((member) => member.userId === subId)) {
        refuse("not_found");
      }
      team.members = team.members.filter((member) => member.userId !== subId);
      return noContent();
    }
  }
  return refuse("not_found");
}

function permissionsOf(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => ALL_PERMISSIONS.includes(String(item)))) {
    refuse("validation", "permissions");
  }
  const permissions = value.map(String);
  // Only the built-in owner role holds org:delete.
  if (permissions.includes("org:delete")) {
    refuse("validation", "permissions");
  }
  return permissions;
}

function roleName(state: FakeAdminState, value: unknown, except?: WireRole): string {
  const roleName = name(value);
  if (["owner", "admin", "editor", "viewer"].includes(roleName.toLowerCase())) {
    refuse("validation", "name");
  }
  if (
    state.roles.some(
      (role) => role !== except && role.name.toLowerCase() === roleName.toLowerCase(),
    )
  ) {
    refuse("conflict", "name");
  }
  return roleName;
}

function description(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (Array.from(text).length > 500) {
    refuse("validation", "description");
  }
  return text;
}

function roles(
  state: FakeAdminState,
  id: string | undefined,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  if (id === undefined && method === "GET") {
    needs(state, "roles:read");
    params(search, PAGING);
    return json(200, { items: state.roles, nextCursor: null });
  }
  needs(state, "roles:write");
  if (id === undefined && method === "POST") {
    const fields = body(input, ["name", "permissions"], ["description"]);
    const role: WireRole = {
      id: newId("r"),
      name: roleName(state, fields.name),
      description: description(fields.description),
      builtin: false,
      permissions: permissionsOf(fields.permissions),
      createdAt: T0 + 10 * DAY,
    };
    if (state.roles.filter((candidate) => !candidate.builtin).length >= 100) {
      refuse("conflict");
    }
    holds(state, role.permissions);
    state.roles.push(role);
    return json(201, role);
  }
  const role = state.roles.find((candidate) => candidate.id === id);
  if (role === undefined) {
    refuse("not_found");
  }
  if (role.builtin) {
    refuse("forbidden");
  }
  holds(state, role.permissions);
  if (method === "PATCH") {
    const fields = body(input, [], ["name", "description", "permissions"]);
    const next = {
      name: fields.name === undefined ? role.name : roleName(state, fields.name, role),
      description:
        fields.description === undefined ? role.description : description(fields.description),
      permissions:
        fields.permissions === undefined ? role.permissions : permissionsOf(fields.permissions),
    };
    holds(state, next.permissions);
    Object.assign(role, next);
    return json(200, role);
  }
  if (method === "DELETE") {
    if (state.members.some((member) => member.role === role.id)) {
      refuse("conflict");
    }
    state.roles = state.roles.filter((candidate) => candidate !== role);
    return noContent();
  }
  return refuse("not_found");
}

const LEVELS: Record<string, string[]> = {
  folder: ["view", "edit", "admin"],
  dashboard: ["view", "edit", "admin"],
  datasource: ["query", "edit", "admin"],
};

function grants(
  state: FakeAdminState,
  id: string | undefined,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  const manage = () => {
    if (!state.managesResources) {
      refuse("forbidden");
    }
  };
  if (id === undefined && method === "GET") {
    params(search, ["resourceType", "resourceId", ...PAGING]);
    const type = search.get("resourceType");
    if (type === null || LEVELS[type] === undefined) {
      refuse("validation", "resourceType");
    }
    if (search.get("resourceId") === null) {
      refuse("validation", "resourceId");
    }
    manage();
    const list = state.grants.filter(
      (grant) => grant.resourceType === type && grant.resourceId === search.get("resourceId"),
    );
    return page(list, search, state.pageSize);
  }
  if (id === undefined && method === "POST") {
    const fields = body(input, ["subjectType", "subjectId", "resourceType", "resourceId", "level"]);
    const type = String(fields.resourceType);
    const levels = LEVELS[type];
    if (levels === undefined) {
      refuse("validation", "resourceType");
    }
    if (!levels.includes(String(fields.level))) {
      refuse("validation", "level");
    }
    manage();
    const subjectType = String(fields.subjectType);
    const subjectId = String(fields.subjectId);
    let subjectName: string | undefined;
    if (subjectType === "user") {
      subjectName = state.members.find((member) => member.userId === subjectId)?.name;
    } else if (subjectType === "team") {
      subjectName = state.teams.find((team) => team.id === subjectId)?.name;
    } else if (subjectType === "role") {
      subjectName = state.roles.find((role) => role.id === subjectId)?.name;
    } else {
      refuse("validation", "subjectType");
    }
    if (subjectName === undefined) {
      refuse("validation", "subjectId");
    }
    const existing = state.grants.find(
      (grant) =>
        grant.subjectType === subjectType &&
        grant.subjectId === subjectId &&
        grant.resourceType === type &&
        grant.resourceId === String(fields.resourceId),
    );
    if (existing !== undefined) {
      existing.level = String(fields.level);
      return json(200, existing);
    }
    const grant: WireGrant = {
      id: newId("g"),
      subjectType,
      subjectId,
      subjectName,
      resourceType: type,
      resourceId: String(fields.resourceId),
      level: String(fields.level),
      createdAt: T0 + 10 * DAY,
    };
    state.grants.push(grant);
    return json(201, grant);
  }
  if (id !== undefined && method === "DELETE") {
    if (!state.grants.some((grant) => grant.id === id)) {
      refuse("not_found");
    }
    manage();
    state.grants = state.grants.filter((grant) => grant.id !== id);
    return noContent();
  }
  return refuse("not_found");
}

const SETTING_VALUES: Record<string, (value: unknown) => boolean> = {
  "appearance.default_theme": (value) =>
    typeof value === "string" && ["system", "light", "dark", "contrast"].includes(value),
  "datasources.max_rows": (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000_000,
  "dashboards.default_time_range": (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Input).from === "string" &&
    typeof (value as Input).to === "string",
  // A JSON setting as a newer server could add one (settings.test.tsx).
  "future.limits": (value) =>
    typeof value === "object" && value !== null && typeof (value as Input).rows === "number",
};

/**
 * Export, import preview and batch (docs/api/settings-dashboards.md, "Export and import"): the
 * export holds the editable settings, the batch applies all changes or none.
 */
function settingsExtras(
  server: FakeServer,
  settings: WireSetting[],
  scope: "server" | "org",
  id: string | undefined,
  method: string,
  input: unknown,
): Response | undefined {
  const locked = (setting: WireSetting) =>
    !setting.editable || setting.source === "env" || setting.source === "file";
  if (id === "export" && method === "GET") {
    return json(200, {
      format: "kalzit.settings",
      formatVersion: 1,
      scope,
      exportedAt: T0,
      settings: Object.fromEntries(
        settings
          .filter((setting) => !locked(setting))
          .map((setting) => [setting.key, setting.value]),
      ),
    });
  }
  if (id === "import" && method === "POST") {
    const document = body(input, ["document"]).document as Input;
    if (document?.format !== "kalzit.settings" || document.scope !== scope) {
      refuse("validation", "document");
    }
    const items = Object.entries((document.settings ?? {}) as Input).map(([key, value]) => {
      const stored = settings.find((setting) => setting.key === key);
      if (stored === undefined) {
        return { key, status: "unknown", current: null, imported: value, version: 0 };
      }
      const status = locked(stored)
        ? "locked"
        : !(SETTING_VALUES[key]?.(value) ?? true)
          ? "invalid"
          : JSON.stringify(value) === JSON.stringify(stored.value)
            ? "same"
            : "change";
      return {
        key,
        status,
        current: stored.value,
        imported: value,
        version: stored.version,
        source: stored.source,
      };
    });
    return json(200, { items, nextCursor: null });
  }
  if (id === "batch" && method === "POST") {
    const changes = body(input, ["changes"]).changes as {
      key: string;
      value?: unknown;
      reset?: boolean;
      version: number;
    }[];
    for (const change of changes) {
      const stored = settings.find((setting) => setting.key === change.key);
      if (stored === undefined || (change.reset === true) === "value" in change) {
        refuse("validation", "changes");
      }
      if (locked(stored)) {
        refuse("conflict");
      }
      if (change.reset !== true && !(SETTING_VALUES[stored.key]?.(change.value) ?? true)) {
        refuse("validation", "changes");
      }
      if (stored.version !== change.version) {
        refuse("version_conflict", undefined, { current: { items: settings, nextCursor: null } });
      }
    }
    const saved = changes.map((change) => {
      const stored = settings.find((setting) => setting.key === change.key) as WireSetting;
      if (change.reset === true) {
        // The stored value goes: the default applies again, and the version keeps counting
        // (a setting never saved stays at 0).
        stored.value = stored.default;
        stored.version = stored.version === 0 ? 0 : stored.version + 1;
        stored.source = "default";
        if (stored.key === "appearance.default_theme") {
          server.state.branding.defaultTheme = stored.value;
          server.state.preferences.defaults.theme = String(stored.value);
        }
        return stored;
      }
      stored.value = change.value;
      stored.version += 1;
      stored.source = "database";
      stored.updatedAt = T0 + 10 * DAY;
      stored.updatedBy = server.state.user.id;
      return stored;
    });
    return json(200, { items: saved, nextCursor: null });
  }
  return undefined;
}

function patchSetting(
  server: FakeServer,
  settings: WireSetting[],
  key: string | undefined,
  method: string,
  input: unknown,
): Response {
  const stored = settings.find((candidate) => candidate.key === key);
  if (stored === undefined || method !== "PATCH") {
    refuse("not_found");
  }
  const fields = body(input, ["value", "version"]);
  if (!stored.editable || stored.source === "env") {
    refuse("conflict");
  }
  if (!(SETTING_VALUES[stored.key]?.(fields.value) ?? true)) {
    refuse("validation", "value");
  }
  if (fields.version !== stored.version) {
    refuse("version_conflict", undefined, { current: stored });
  }
  stored.value = fields.value;
  stored.version += 1;
  stored.source = "database";
  stored.updatedAt = T0 + 10 * DAY;
  stored.updatedBy = server.state.user.id;
  if (stored.key === "appearance.default_theme") {
    // The brand and every user's preferences read the same setting, as on the server.
    server.state.branding.defaultTheme = stored.value;
    server.state.preferences.defaults.theme = String(stored.value);
  }
  return json(200, stored);
}

function audit(
  events: readonly WireAuditEvent[],
  search: URLSearchParams,
  size: number,
  server: boolean,
): Response {
  params(search, [
    "actor",
    "action",
    "resourceType",
    "resourceId",
    "from",
    "to",
    ...(server ? ["orgId"] : []),
    ...PAGING,
  ]);
  const time = (name: string) => {
    const text = search.get(name);
    if (text === null) {
      return undefined;
    }
    const value = Number(text);
    if (!Number.isInteger(value)) {
      refuse("validation", name);
    }
    return value;
  };
  const from = time("from");
  const to = time("to");
  if (from !== undefined && to !== undefined && from > to) {
    refuse("validation", "from");
  }
  const actor = search.get("actor");
  const action = search.get("action");
  const orgId = search.get("orgId");
  const matching = events.filter(
    (event) =>
      (actor === null || event.actorUserId === actor) &&
      (action === null || event.action.startsWith(action)) &&
      (orgId === null || event.orgId === orgId) &&
      (from === undefined || event.createdAt >= from) &&
      (to === undefined || event.createdAt < to),
  );
  return page(matching, search, size);
}

function handleServerAdmin(
  server: FakeServer,
  state: FakeAdminState,
  path: string,
  method: string,
  input: unknown,
  search: URLSearchParams,
): Response {
  const [, , , area = "", id] = path.split("/").map(decodeURIComponent);
  if (area === "users") {
    if (id === undefined && method === "GET") {
      return page(state.users, params(search, PAGING), state.pageSize);
    }
    if (id === undefined && method === "POST") {
      const fields = body(input, ["name", "email", "password"], ["isServerAdmin"]);
      const email = String(fields.email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        refuse("validation", "email");
      }
      if (typeof fields.password !== "string" || Array.from(fields.password).length < 12) {
        refuse("validation", "password");
      }
      if (state.users.some((user) => user.email === email)) {
        refuse("conflict", "email");
      }
      const user: WireAdminUser = {
        id: newId("u"),
        email,
        name: name(fields.name),
        isServerAdmin: fields.isServerAdmin === true,
        disabled: false,
        createdAt: T0 + 20 * DAY,
      };
      state.users.push(user);
      return json(201, user);
    }
    const user = state.users.find((candidate) => candidate.id === id);
    if (user === undefined || method !== "PATCH") {
      refuse("not_found");
    }
    const fields = body(input, [], ["name", "disabled", "isServerAdmin", "password"]);
    const activeAdmins = state.users.filter(
      (candidate) => candidate.isServerAdmin && !candidate.disabled,
    );
    const lastAdmin = user.isServerAdmin && !user.disabled && activeAdmins.length === 1;
    if (lastAdmin && (fields.isServerAdmin === false || fields.disabled === true)) {
      refuse("conflict");
    }
    // Disabling the last enabled owner of an organization is refused as well.
    const ownsAlone =
      state.members.some((member) => member.userId === user.id && member.role === "owner") &&
      owners(state) === 1;
    if (fields.disabled === true && !user.disabled && ownsAlone) {
      refuse("conflict");
    }
    if (fields.password !== undefined && Array.from(String(fields.password)).length < 12) {
      refuse("validation", "password");
    }
    if (fields.name !== undefined) user.name = name(fields.name);
    if (typeof fields.disabled === "boolean") user.disabled = fields.disabled;
    if (typeof fields.isServerAdmin === "boolean") user.isServerAdmin = fields.isServerAdmin;
    if (user.id === server.state.user.id) {
      server.state.user = { ...server.state.user, isServerAdmin: user.isServerAdmin };
    }
    return json(200, user);
  }
  if (area === "orgs") {
    if (id === undefined && method === "GET") {
      return page(state.orgs, params(search, PAGING), state.pageSize);
    }
    if (id === undefined && method === "POST") {
      const fields = body(input, ["name", "ownerUserId"]);
      if (!state.users.some((user) => user.id === fields.ownerUserId && !user.disabled)) {
        refuse("validation", "ownerUserId");
      }
      const org: WireAdminOrg = {
        id: newId("o"),
        name: name(fields.name),
        memberCount: 1,
        createdAt: T0 + 20 * DAY,
      };
      state.orgs.push(org);
      return json(201, org);
    }
    const org = state.orgs.find((candidate) => candidate.id === id);
    if (org === undefined || method !== "PATCH") {
      refuse("not_found");
    }
    org.name = name(body(input, ["name"]).name);
    return json(200, org);
  }
  if (area === "settings") {
    if (id === undefined && method === "GET") {
      return page(state.serverSettings, params(search, PAGING), state.pageSize);
    }
    return (
      settingsExtras(server, state.serverSettings, "server", id, method, input) ??
      patchSetting(server, state.serverSettings, id, method, input)
    );
  }
  if (area === "audit" && id === undefined && method === "GET") {
    return audit(state.audit, search, state.pageSize, true);
  }
  return refuse("not_found");
}
