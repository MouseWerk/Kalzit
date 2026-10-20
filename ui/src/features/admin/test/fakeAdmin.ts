import type { FakeServer } from "../../../test/fakeServer";
import { TEST_PASSWORD } from "../../../test/fakeServer";
import type {
  AdminOrg,
  AdminUser,
  AuditEvent,
  ExplainEntry,
  Grant,
  Member,
  OrgSetting,
  Role,
  ServerSetting,
  Session,
  Team,
  TeamMember,
} from "../api";

/**
 * The administration routes of the fake server (test/fakeServer.ts registers them): members,
 * teams, roles, grants, explain, settings, audit, server administration and the user's own
 * account. Like the rest of the fake it follows the contract (status codes, error envelope,
 * `Page<T>`, versioned settings) closely enough for the UI; it does not check permissions, which
 * the real server does and its own tests cover. The protection rules are modelled: the last owner
 * and the last server admin stay (409 conflict), and stale setting versions answer
 * `version_conflict` with the stored setting as `current`.
 */
export interface FakeAdminState {
  members: Member[];
  teams: (Team & { roles: string[]; members: TeamMember[] })[];
  roles: Role[];
  grants: Grant[];
  explain: ExplainEntry[];
  orgSettings: OrgSetting[];
  audit: AuditEvent[];
  users: AdminUser[];
  orgs: AdminOrg[];
  serverSettings: ServerSetting[];
  sessions: Session[];
  password: string;
  /** Items per list page; tests lower it to exercise paging. */
  pageSize: number;
}

const DAY = 86_400_000;
// A fixed point in time (2026-03-01), so dates in tests do not depend on the clock.
const T0 = Date.UTC(2026, 2, 1);

function builtInRole(id: string, permissions: string[]): Role {
  return { id, name: id, description: "", builtin: true, permissions };
}

function initialState(server: FakeServer): FakeAdminState {
  const me = server.state.user;
  return {
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
        memberCount: 1,
        roles: [],
        members: [
          {
            userId: "u2",
            name: "Grace Hopper",
            email: "grace@example.com",
            teamRole: "maintainer",
          },
        ],
      },
    ],
    roles: [
      builtInRole("owner", ["dashboards:read", "users:write", "org:delete"]),
      builtInRole("admin", ["dashboards:read", "users:write"]),
      builtInRole("editor", ["dashboards:read", "dashboards:write", "users:read"]),
      builtInRole("viewer", ["dashboards:read"]),
      {
        id: "r1",
        name: "Auditor",
        description: "Reads the audit log",
        builtin: false,
        permissions: ["audit:read"],
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
      },
    ],
    explain: [{ kind: "orgRole", name: "owner" }],
    orgSettings: [
      { key: "dashboards.default_refresh", value: "30s", version: 1, editable: true },
      { key: "audit.retention_days", value: 365, version: 1, editable: true },
      { key: "security.require_2fa", value: false, version: 1, editable: true },
      { key: "org.id_format", value: "uuid", version: 1, editable: false },
    ],
    audit: [
      {
        id: "a1",
        action: "team.created",
        actorUserId: me.id,
        actorName: me.name,
        actorAddress: "192.0.2.10",
        resourceType: "team",
        resourceId: "t1",
        summary: "name",
        createdAt: T0 + 3 * DAY,
      },
      {
        id: "a2",
        action: "auth.signed_in",
        actorUserId: "u2",
        actorName: "Grace Hopper",
        actorAddress: "192.0.2.11",
        resourceType: null,
        resourceId: null,
        summary: null,
        createdAt: T0 + 2 * DAY,
      },
      {
        id: "a3",
        action: "custom.unknown_action",
        actorUserId: null,
        actorName: null,
        actorAddress: null,
        resourceType: null,
        resourceId: null,
        summary: { fields: ["value"] },
        createdAt: T0 + DAY,
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
    ],
    orgs: me.orgs.map((org) => ({ id: org.id, name: org.name, memberCount: 3 })),
    serverSettings: [
      {
        key: "server.http_port",
        value: 3000,
        source: "env",
        editable: false,
        version: 1,
        description: "HTTP port",
      },
      {
        key: "server.public_url",
        value: "https://kalzit.example",
        source: "file",
        editable: false,
        version: 1,
        description: "Public address",
      },
      {
        key: "appearance.default_theme",
        value: "system",
        source: "default",
        editable: true,
        version: 1,
        description: "Default theme",
      },
      {
        key: "security.trusted_proxies",
        value: [],
        source: "default",
        editable: false,
        version: 1,
        description: "Trusted proxies",
      },
    ],
    sessions: [
      {
        id: "s1",
        createdAt: T0,
        lastSeenAt: T0 + DAY,
        current: true,
        userAgent: "Firefox on Linux",
      },
      {
        id: "s2",
        createdAt: T0,
        lastSeenAt: T0 + DAY,
        current: false,
        userAgent: "Edge on Windows",
      },
      { id: "s3", createdAt: T0, lastSeenAt: T0 + DAY, current: false },
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, message: `server message for ${code}` }, ...extra });
}

const noContent = () => new Response(null, { status: 204 });

function page<T>(items: T[], params: URLSearchParams, size: number): Response {
  const start = Number(params.get("cursor") ?? "0");
  const limit = Math.min(Number(params.get("limit") ?? size), size);
  const end = start + limit;
  return json(200, {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  });
}

let nextId = 100;
const newId = (prefix: string) => `${prefix}${nextId++}`;

type Input = Record<string, unknown>;

/**
 * Answers an administration route, or undefined when the path is not one of them. Registered in
 * test/fakeServer.ts before its final not_found.
 */
export function handleAdminRoute(
  server: FakeServer,
  rawPath: string,
  method: string,
  body: unknown,
): Response | undefined {
  const url = new URL(rawPath, "http://kalzit.test");
  const path = url.pathname;
  const params = url.searchParams;
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
  const input = (body ?? {}) as Input;
  if (isMe) {
    return handleMe(server, state, path, method, input);
  }
  if (isAdmin) {
    return server.state.user.isServerAdmin
      ? handleServerAdmin(state, path, method, input, params)
      : error(403, "forbidden");
  }
  const [, , , orgId = "", ...rest] = path.split("/");
  if (!server.state.user.orgs.some((org) => org.id === decodeURIComponent(orgId))) {
    return error(404, "not_found");
  }
  return handleOrg(state, rest.map(decodeURIComponent), method, input, params);
}

function handleMe(
  server: FakeServer,
  state: FakeAdminState,
  path: string,
  method: string,
  input: Input,
): Response {
  if (path === "/api/me" && method === "PATCH") {
    server.state.user = { ...server.state.user, name: String(input.name) };
    return json(200, server.state.user);
  }
  if (path === "/api/me/password" && method === "POST") {
    if (input.current !== state.password) {
      return error(401, "invalid_credentials");
    }
    state.password = String(input.new);
    return noContent();
  }
  if (path === "/api/me/sessions" && method === "GET") {
    return json(200, state.sessions);
  }
  if (path === "/api/me/sessions/revoke-others" && method === "POST") {
    state.sessions = state.sessions.filter((session) => session.current);
    return noContent();
  }
  const session = /^\/api\/me\/sessions\/([^/]+)$/.exec(path);
  if (session !== null && method === "DELETE") {
    state.sessions = state.sessions.filter((candidate) => candidate.id !== session[1]);
    return noContent();
  }
  return error(404, "not_found");
}

function owners(state: FakeAdminState): number {
  return state.members.filter((member) => member.role === "owner").length;
}

function handleOrg(
  state: FakeAdminState,
  rest: string[],
  method: string,
  input: Input,
  params: URLSearchParams,
): Response {
  const [area, id, sub, subId] = rest;

  if (area === "members") {
    if (id === undefined && method === "GET") {
      return page(state.members, params, state.pageSize);
    }
    if (id === undefined && method === "POST") {
      const user = state.users.find((candidate) => candidate.email === input.email);
      if (user === undefined) {
        return error(404, "not_found");
      }
      if (state.members.some((member) => member.userId === user.id)) {
        return error(409, "conflict");
      }
      state.members.push({
        userId: user.id,
        email: user.email,
        name: user.name,
        role: String(input.role),
        joinedAt: T0 + 10 * DAY,
      });
      return json(201, state.members.at(-1));
    }
    const member = state.members.find((candidate) => candidate.userId === id);
    if (member === undefined) {
      return error(404, "not_found");
    }
    const lastOwner = member.role === "owner" && owners(state) === 1;
    if (method === "PATCH") {
      if (lastOwner && input.role !== "owner") {
        return error(409, "conflict");
      }
      member.role = String(input.role);
      return json(200, member);
    }
    if (method === "DELETE") {
      if (lastOwner) {
        return error(409, "conflict");
      }
      state.members = state.members.filter((candidate) => candidate !== member);
      return noContent();
    }
  }

  if (area === "teams") {
    if (id === undefined && method === "GET") {
      return page(
        state.teams.map(({ id: teamId, name, memberCount }) => ({ id: teamId, name, memberCount })),
        params,
        state.pageSize,
      );
    }
    if (id === undefined && method === "POST") {
      if (state.teams.some((team) => team.name === input.name)) {
        return error(409, "conflict");
      }
      const team = {
        id: newId("t"),
        name: String(input.name),
        memberCount: 0,
        roles: [],
        members: [],
      };
      state.teams.push(team);
      return json(201, { id: team.id, name: team.name, memberCount: 0 });
    }
    const team = state.teams.find((candidate) => candidate.id === id);
    if (team === undefined) {
      return error(404, "not_found");
    }
    if (sub === undefined) {
      if (method === "GET") {
        return json(200, {
          id: team.id,
          name: team.name,
          memberCount: team.memberCount,
          roles: team.roles,
        });
      }
      if (method === "PATCH") {
        team.name = String(input.name);
        return json(200, { id: team.id, name: team.name, memberCount: team.memberCount });
      }
      if (method === "DELETE") {
        state.teams = state.teams.filter((candidate) => candidate !== team);
        return noContent();
      }
    }
    if (sub === "roles" && method === "PUT") {
      team.roles = (input.roles as string[]).slice();
      return noContent();
    }
    if (sub === "members") {
      if (subId === undefined && method === "GET") {
        return page(team.members, params, state.pageSize);
      }
      if (method === "PUT") {
        const existing = team.members.find((member) => member.userId === subId);
        const teamRole = input.teamRole === "maintainer" ? "maintainer" : "member";
        if (existing !== undefined) {
          existing.teamRole = teamRole;
        } else {
          const member = state.members.find((candidate) => candidate.userId === subId);
          if (member === undefined) {
            return error(404, "not_found");
          }
          team.members.push({
            userId: member.userId,
            name: member.name,
            email: member.email,
            teamRole,
          });
        }
        team.memberCount = team.members.length;
        return noContent();
      }
      if (method === "DELETE") {
        team.members = team.members.filter((member) => member.userId !== subId);
        team.memberCount = team.members.length;
        return noContent();
      }
    }
  }

  if (area === "roles") {
    if (id === undefined && method === "GET") {
      return json(200, state.roles);
    }
    if (id === undefined && method === "POST") {
      if (state.roles.some((role) => role.name === input.name)) {
        return error(409, "conflict");
      }
      const role: Role = {
        id: newId("r"),
        name: String(input.name),
        description: String(input.description ?? ""),
        builtin: false,
        permissions: (input.permissions as string[]).slice(),
      };
      state.roles.push(role);
      return json(201, role);
    }
    const role = state.roles.find((candidate) => candidate.id === id);
    if (role === undefined) {
      return error(404, "not_found");
    }
    if (role.builtin) {
      return error(403, "forbidden");
    }
    if (method === "PATCH") {
      role.name = String(input.name);
      role.description = String(input.description ?? "");
      role.permissions = (input.permissions as string[]).slice();
      return json(200, role);
    }
    if (method === "DELETE") {
      state.roles = state.roles.filter((candidate) => candidate !== role);
      return noContent();
    }
  }

  if (area === "grants") {
    if (id === undefined && method === "GET") {
      return json(
        200,
        state.grants.filter(
          (grant) =>
            grant.resourceType === params.get("resourceType") &&
            grant.resourceId === params.get("resourceId"),
        ),
      );
    }
    if (id === undefined && method === "POST") {
      const subjectType = input.subjectType as Grant["subjectType"];
      const subjectId = String(input.subjectId);
      let subjectName = subjectId;
      if (subjectType === "user") {
        subjectName =
          state.members.find((member) => member.userId === subjectId)?.name ?? subjectId;
      } else if (subjectType === "team") {
        subjectName = state.teams.find((team) => team.id === subjectId)?.name ?? subjectId;
      } else {
        subjectName = state.roles.find((role) => role.id === subjectId)?.name ?? subjectId;
      }
      const grant: Grant = {
        id: newId("g"),
        subjectType,
        subjectId,
        subjectName,
        resourceType: input.resourceType as Grant["resourceType"],
        resourceId: String(input.resourceId),
        level: input.level as Grant["level"],
      };
      state.grants.push(grant);
      return json(201, grant);
    }
    if (method === "DELETE") {
      state.grants = state.grants.filter((grant) => grant.id !== id);
      return noContent();
    }
  }

  if (area === "explain" && method === "GET") {
    return json(200, state.explain);
  }

  if (area === "settings") {
    if (id === undefined && method === "GET") {
      return json(200, state.orgSettings);
    }
    return patchSetting(state.orgSettings, id, method, input);
  }

  if (area === "audit" && method === "GET") {
    return audit(state, params);
  }

  return error(404, "not_found");
}

function patchSetting<S extends OrgSetting>(
  settings: S[],
  key: string | undefined,
  method: string,
  input: Input,
): Response {
  const setting = settings.find((candidate) => candidate.key === key);
  if (setting === undefined || method !== "PATCH") {
    return error(404, "not_found");
  }
  if (!setting.editable) {
    return error(403, "forbidden");
  }
  if (input.version !== setting.version) {
    return error(409, "version_conflict", { current: setting });
  }
  setting.value = input.value;
  setting.version += 1;
  return json(200, setting);
}

function audit(state: FakeAdminState, params: URLSearchParams): Response {
  const actor = params.get("actor");
  const action = params.get("action");
  const from = params.get("from");
  const to = params.get("to");
  const events = state.audit.filter(
    (event) =>
      (actor === null || event.actorUserId === actor) &&
      (action === null || event.action === action) &&
      (from === null || event.createdAt >= Number(from)) &&
      (to === null || event.createdAt <= Number(to)),
  );
  return page(events, params, state.pageSize);
}

function handleServerAdmin(
  state: FakeAdminState,
  path: string,
  method: string,
  input: Input,
  params: URLSearchParams,
): Response {
  const [, , , area = "", id] = path.split("/").map(decodeURIComponent);
  if (area === "users") {
    if (id === undefined && method === "GET") {
      return page(state.users, params, state.pageSize);
    }
    if (id === undefined && method === "POST") {
      if (state.users.some((user) => user.email === input.email)) {
        return error(409, "conflict");
      }
      const user: AdminUser = {
        id: newId("u"),
        email: String(input.email),
        name: String(input.name),
        isServerAdmin: input.isServerAdmin === true,
        disabled: false,
        createdAt: T0 + 20 * DAY,
      };
      state.users.push(user);
      return json(201, user);
    }
    const user = state.users.find((candidate) => candidate.id === id);
    if (user === undefined || method !== "PATCH") {
      return error(404, "not_found");
    }
    const admins = state.users.filter(
      (candidate) => candidate.isServerAdmin && !candidate.disabled,
    );
    const lastAdmin = user.isServerAdmin && !user.disabled && admins.length === 1;
    if (lastAdmin && (input.isServerAdmin === false || input.disabled === true)) {
      return error(409, "conflict");
    }
    if (typeof input.name === "string") user.name = input.name;
    if (typeof input.disabled === "boolean") user.disabled = input.disabled;
    if (typeof input.isServerAdmin === "boolean") user.isServerAdmin = input.isServerAdmin;
    return json(200, user);
  }
  if (area === "orgs") {
    if (id === undefined && method === "GET") {
      return page(state.orgs, params, state.pageSize);
    }
    if (id === undefined && method === "POST") {
      const org: AdminOrg = { id: newId("o"), name: String(input.name), memberCount: 1 };
      state.orgs.push(org);
      return json(201, org);
    }
    const org = state.orgs.find((candidate) => candidate.id === id);
    if (org === undefined || method !== "PATCH") {
      return error(404, "not_found");
    }
    org.name = String(input.name);
    return json(200, org);
  }
  if (area === "settings") {
    if (id === undefined && method === "GET") {
      return json(200, state.serverSettings);
    }
    return patchSetting(state.serverSettings, id, method, input);
  }
  if (area === "audit" && method === "GET") {
    return audit(state, params);
  }
  return error(404, "not_found");
}
