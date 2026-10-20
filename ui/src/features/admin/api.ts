/**
 * Calls of the administration area: organization members, teams, roles, grants, settings and
 * audit log, the server administration, and the signed-in user's own account. Every response is
 * checked against the contract (docs/ARCHITECTURE.md), so a mismatch fails as `invalid_response`
 * instead of rendering half a page.
 */
import { expectShape, isRecord, request } from "../../api/client";

// Small shape checks, combined per type below.

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const isAny: Check = () => true;

function nullable(check: Check): Check {
  return (value) => value === null || value === undefined || check(value);
}

function optional(check: Check): Check {
  return (value) => value === undefined || check(value);
}

function oneOf(...values: readonly string[]): Check {
  return (value) => typeof value === "string" && values.includes(value);
}

function arrayOf(check: Check): Check {
  return (value) => Array.isArray(value) && value.every(check);
}

function shape<T>(fields: Record<keyof T, Check>): (value: unknown) => value is T {
  return (value): value is T =>
    isRecord(value) && Object.entries<Check>(fields).every(([name, check]) => check(value[name]));
}

/** A list page, `{ items, nextCursor }`. */
export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Lists answer `Page<T>`; a bare array is accepted as a single page, so a route that answers the
 * whole list at once (roles, grants) reads the same way.
 */
function pageOf<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): value is ListPage<T> | T[] =>
    (Array.isArray(value) && value.every(guard)) ||
    (isRecord(value) &&
      Array.isArray(value.items) &&
      value.items.every(guard) &&
      (value.nextCursor === null ||
        value.nextCursor === undefined ||
        typeof value.nextCursor === "string"));
}

function asPage<T>(value: ListPage<T> | T[]): ListPage<T> {
  return Array.isArray(value) ? { items: value, nextCursor: null } : value;
}

function arrayGuard<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(guard);
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(name, String(value));
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

const enc = encodeURIComponent;

function orgPath(orgId: string, rest: string): string {
  return `/api/orgs/${enc(orgId)}${rest}`;
}

/** The largest page the server hands out (docs/ARCHITECTURE.md); pickers ask for this much. */
export const MAX_PAGE_SIZE = 200;

// Members

export interface Member {
  userId: string;
  email: string;
  name: string;
  /** A built-in role name (owner, admin, editor, viewer) or the id of a custom role. */
  role: string;
  joinedAt: number;
}

const isMember = shape<Member>({
  userId: isString,
  email: isString,
  name: isString,
  role: isString,
  joinedAt: isNumber,
});

export async function listMembers(
  orgId: string,
  cursor?: string,
  limit?: number,
): Promise<ListPage<Member>> {
  const path = orgPath(orgId, `/members${query({ cursor, limit })}`);
  return asPage(expectShape(await request("GET", path), pageOf(isMember), "members"));
}

export async function addMember(orgId: string, input: { email: string; role: string }) {
  await request("POST", orgPath(orgId, "/members"), input);
}

export async function changeMemberRole(orgId: string, userId: string, role: string) {
  await request("PATCH", orgPath(orgId, `/members/${enc(userId)}`), { role });
}

export async function removeMember(orgId: string, userId: string) {
  await request("DELETE", orgPath(orgId, `/members/${enc(userId)}`));
}

// Teams

export const TEAM_ROLES = ["member", "maintainer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export interface Team {
  id: string;
  name: string;
  memberCount: number;
  /** Role ids assigned to the team; only the single-team route sends them. */
  roles?: string[] | undefined;
}

const isTeam = shape<Team>({
  id: isString,
  name: isString,
  memberCount: isNumber,
  roles: optional(arrayOf(isString)),
});

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  teamRole: TeamRole;
}

const isTeamMember = shape<TeamMember>({
  userId: isString,
  name: isString,
  email: isString,
  teamRole: oneOf(...TEAM_ROLES),
});

export async function listTeams(
  orgId: string,
  cursor?: string,
  limit?: number,
): Promise<ListPage<Team>> {
  const path = orgPath(orgId, `/teams${query({ cursor, limit })}`);
  return asPage(expectShape(await request("GET", path), pageOf(isTeam), "teams"));
}

export async function fetchTeam(orgId: string, teamId: string): Promise<Team> {
  return expectShape(await request("GET", orgPath(orgId, `/teams/${enc(teamId)}`)), isTeam, "team");
}

export async function createTeam(orgId: string, name: string): Promise<Team | undefined> {
  const created = await request("POST", orgPath(orgId, "/teams"), { name });
  return isTeam(created) ? created : undefined;
}

export async function renameTeam(orgId: string, teamId: string, name: string) {
  await request("PATCH", orgPath(orgId, `/teams/${enc(teamId)}`), { name });
}

export async function deleteTeam(orgId: string, teamId: string) {
  await request("DELETE", orgPath(orgId, `/teams/${enc(teamId)}`));
}

export async function listTeamMembers(
  orgId: string,
  teamId: string,
  cursor?: string,
): Promise<ListPage<TeamMember>> {
  const path = orgPath(orgId, `/teams/${enc(teamId)}/members${query({ cursor })}`);
  return asPage(expectShape(await request("GET", path), pageOf(isTeamMember), "team members"));
}

export async function putTeamMember(
  orgId: string,
  teamId: string,
  userId: string,
  teamRole: TeamRole,
) {
  await request("PUT", orgPath(orgId, `/teams/${enc(teamId)}/members/${enc(userId)}`), {
    teamRole,
  });
}

export async function removeTeamMember(orgId: string, teamId: string, userId: string) {
  await request("DELETE", orgPath(orgId, `/teams/${enc(teamId)}/members/${enc(userId)}`));
}

export async function setTeamRoles(orgId: string, teamId: string, roles: string[]) {
  await request("PUT", orgPath(orgId, `/teams/${enc(teamId)}/roles`), { roles });
}

// Roles

export interface Role {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  /** Strings, not Permission: the server may know permissions newer than this UI. */
  permissions: string[];
}

const isRole = shape<Role>({
  id: isString,
  name: isString,
  description: isString,
  builtin: isBoolean,
  permissions: arrayOf(isString),
});

export interface RoleInput {
  name: string;
  description: string;
  permissions: string[];
}

export async function listRoles(orgId: string): Promise<Role[]> {
  return expectShape(await request("GET", orgPath(orgId, "/roles")), arrayGuard(isRole), "roles");
}

export async function createRole(orgId: string, input: RoleInput): Promise<Role | undefined> {
  const created = await request("POST", orgPath(orgId, "/roles"), input);
  return isRole(created) ? created : undefined;
}

export async function updateRole(orgId: string, roleId: string, input: RoleInput) {
  await request("PATCH", orgPath(orgId, `/roles/${enc(roleId)}`), input);
}

export async function deleteRole(orgId: string, roleId: string) {
  await request("DELETE", orgPath(orgId, `/roles/${enc(roleId)}`));
}

// Grants and explain

export const RESOURCE_TYPES = ["folder", "dashboard", "datasource"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const SUBJECT_TYPES = ["user", "team", "role"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const GRANT_LEVELS = ["view", "edit", "admin", "query"] as const;
export type GrantLevel = (typeof GRANT_LEVELS)[number];

/** Folders and dashboards are viewed, data sources are queried (docs/ARCHITECTURE.md). */
export function levelsFor(resourceType: ResourceType): readonly GrantLevel[] {
  return resourceType === "datasource" ? ["query", "edit", "admin"] : ["view", "edit", "admin"];
}

export interface Grant {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  subjectName: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
}

const isGrant = shape<Grant>({
  id: isString,
  subjectType: oneOf(...SUBJECT_TYPES),
  subjectId: isString,
  subjectName: isString,
  resourceType: oneOf(...RESOURCE_TYPES),
  resourceId: isString,
  level: oneOf(...GRANT_LEVELS),
});

export interface GrantInput {
  subjectType: SubjectType;
  subjectId: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
}

export async function listGrants(
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
): Promise<Grant[]> {
  const path = orgPath(orgId, `/grants${query({ resourceType, resourceId })}`);
  return expectShape(await request("GET", path), arrayGuard(isGrant), "grants");
}

export async function addGrant(orgId: string, input: GrantInput) {
  await request("POST", orgPath(orgId, "/grants"), input);
}

export async function removeGrant(orgId: string, grantId: string) {
  await request("DELETE", orgPath(orgId, `/grants/${enc(grantId)}`));
}

export const EXPLAIN_KINDS = ["orgRole", "teamRole", "customRole", "grant"] as const;
export type ExplainKind = (typeof EXPLAIN_KINDS)[number];

export interface ExplainEntry {
  kind: ExplainKind;
  name: string;
}

const isExplainEntry = shape<ExplainEntry>({ kind: oneOf(...EXPLAIN_KINDS), name: isString });

export async function explainPermission(
  orgId: string,
  permission: string,
  resource?: { type: ResourceType; id: string },
): Promise<ExplainEntry[]> {
  const path = orgPath(
    orgId,
    `/explain${query({ permission, resourceType: resource?.type, resourceId: resource?.id })}`,
  );
  return expectShape(await request("GET", path), arrayGuard(isExplainEntry), "explain");
}

// Settings (organization and server share the versioned update)

export interface OrgSetting {
  key: string;
  value: unknown;
  version: number;
  editable: boolean;
}

const isOrgSetting = shape<OrgSetting>({
  key: isString,
  value: isAny,
  version: isNumber,
  editable: isBoolean,
});

export const SETTING_SOURCES = ["env", "file", "database", "default"] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

export interface ServerSetting extends OrgSetting {
  source: SettingSource;
  description: string;
}

const isServerSetting = shape<ServerSetting>({
  key: isString,
  value: isAny,
  version: isNumber,
  editable: isBoolean,
  source: oneOf(...SETTING_SOURCES),
  description: isString,
});

export async function listOrgSettings(orgId: string): Promise<OrgSetting[]> {
  const path = orgPath(orgId, "/settings");
  return expectShape(await request("GET", path), arrayGuard(isOrgSetting), "settings");
}

export async function updateOrgSetting(
  orgId: string,
  key: string,
  value: unknown,
  version: number,
) {
  await request("PATCH", orgPath(orgId, `/settings/${enc(key)}`), { value, version });
}

export async function listServerSettings(): Promise<ServerSetting[]> {
  const body = await request("GET", "/api/admin/settings");
  return expectShape(body, arrayGuard(isServerSetting), "server settings");
}

export async function updateServerSetting(key: string, value: unknown, version: number) {
  await request("PATCH", `/api/admin/settings/${enc(key)}`, { value, version });
}

// Audit

export interface AuditEvent {
  id: string;
  action: string;
  actorUserId: string | null;
  actorName: string | null;
  actorAddress: string | null;
  resourceType: string | null;
  resourceId: string | null;
  /** Ids and changed field names (docs/ARCHITECTURE.md); text or a small object. */
  summary: unknown;
  createdAt: number;
  /** Only in the server audit log. */
  orgId?: string | null | undefined;
}

const isAuditEvent = shape<AuditEvent>({
  id: isString,
  action: isString,
  actorUserId: nullable(isString),
  actorName: nullable(isString),
  actorAddress: nullable(isString),
  resourceType: nullable(isString),
  resourceId: nullable(isString),
  summary: isAny,
  createdAt: isNumber,
  orgId: nullable(isString),
});

export interface AuditFilter {
  actor?: string | undefined;
  action?: string | undefined;
  /** Unix milliseconds, inclusive. */
  from?: number | undefined;
  to?: number | undefined;
}

/** Org audit log, or the server's when `orgId` is null. */
export async function listAudit(
  orgId: string | null,
  filter: AuditFilter,
  cursor?: string,
): Promise<ListPage<AuditEvent>> {
  const base = orgId === null ? "/api/admin/audit" : orgPath(orgId, "/audit");
  const path = `${base}${query({ ...filter, cursor })}`;
  return asPage(expectShape(await request("GET", path), pageOf(isAuditEvent), "audit"));
}

// Server administration

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  disabled: boolean;
  createdAt: number;
}

const isAdminUser = shape<AdminUser>({
  id: isString,
  email: isString,
  name: isString,
  isServerAdmin: isBoolean,
  disabled: isBoolean,
  createdAt: isNumber,
});

export interface NewUserInput {
  name: string;
  email: string;
  password: string;
  isServerAdmin: boolean;
}

export type UserPatch = Partial<{
  name: string;
  disabled: boolean;
  isServerAdmin: boolean;
  password: string;
}>;

export async function listUsers(cursor?: string, limit?: number): Promise<ListPage<AdminUser>> {
  const path = `/api/admin/users${query({ cursor, limit })}`;
  return asPage(expectShape(await request("GET", path), pageOf(isAdminUser), "users"));
}

export async function createUser(input: NewUserInput) {
  await request("POST", "/api/admin/users", input);
}

export async function updateUser(userId: string, patch: UserPatch) {
  await request("PATCH", `/api/admin/users/${enc(userId)}`, patch);
}

export interface AdminOrg {
  id: string;
  name: string;
  memberCount: number;
}

const isAdminOrg = shape<AdminOrg>({ id: isString, name: isString, memberCount: isNumber });

export async function listOrgs(cursor?: string): Promise<ListPage<AdminOrg>> {
  const path = `/api/admin/orgs${query({ cursor })}`;
  return asPage(expectShape(await request("GET", path), pageOf(isAdminOrg), "organizations"));
}

export async function createOrg(input: { name: string; ownerUserId: string }) {
  await request("POST", "/api/admin/orgs", input);
}

export async function renameOrg(orgId: string, name: string) {
  await request("PATCH", `/api/admin/orgs/${enc(orgId)}`, { name });
}

// The signed-in user's own account

export interface Session {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
  userAgent?: string | null | undefined;
}

const isSession = shape<Session>({
  id: isString,
  createdAt: isNumber,
  lastSeenAt: isNumber,
  current: isBoolean,
  userAgent: nullable(isString),
});

export async function updateMyName(name: string) {
  await request("PATCH", "/api/me", { name });
}

export async function changeMyPassword(input: { current: string; new: string }) {
  await request("POST", "/api/me/password", input);
}

export async function listMySessions(): Promise<Session[]> {
  const body = await request("GET", "/api/me/sessions");
  return expectShape(body, arrayGuard(isSession), "sessions");
}

export async function revokeSession(sessionId: string) {
  await request("DELETE", `/api/me/sessions/${enc(sessionId)}`);
}

export async function revokeOtherSessions() {
  await request("POST", "/api/me/sessions/revoke-others");
}

// Query keys: everything of an organization's administration under one prefix, so a change can
// refresh what depends on it (a removed member also leaves its teams).

export const adminKeys = {
  org: (orgId: string) => ["admin", "org", orgId] as const,
  members: (orgId: string) => ["admin", "org", orgId, "members"] as const,
  teams: (orgId: string) => ["admin", "org", orgId, "teams"] as const,
  team: (orgId: string, teamId: string) => ["admin", "org", orgId, "teams", teamId] as const,
  roles: (orgId: string) => ["admin", "org", orgId, "roles"] as const,
  grants: (orgId: string, type: ResourceType, id: string) =>
    ["admin", "org", orgId, "grants", type, id] as const,
  explain: (orgId: string, permission: string, type?: ResourceType, id?: string) =>
    ["admin", "org", orgId, "explain", permission, type ?? "", id ?? ""] as const,
  orgSettings: (orgId: string) => ["admin", "org", orgId, "settings"] as const,
  audit: (orgId: string | null, filter: AuditFilter) =>
    ["admin", "audit", orgId ?? "server", filter] as const,
  server: ["admin", "server"] as const,
  users: ["admin", "server", "users"] as const,
  orgs: ["admin", "server", "orgs"] as const,
  serverSettings: ["admin", "server", "settings"] as const,
  sessions: ["admin", "me", "sessions"] as const,
};
