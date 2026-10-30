/**
 * Calls of the administration area: organization members, teams, roles, grants, explain, settings
 * and audit log, the server administration, and the signed-in user's own account. The shapes
 * follow the server's API documents (docs/api/access.md, docs/api/settings-dashboards.md); every
 * response is checked, so a mismatch fails as `invalid_response` instead of rendering half a page.
 */
import { expectShape, isRecord, request } from "../../api/client";
import { isSummary, type SecondFactorSummary } from "../security/api";

// Small shape checks, combined per type below.

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const isAny: Check = () => true;

function nullable(check: Check): Check {
  return (value) => value === null || check(value);
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

/** A list page, `Page<T>`: `{ items, nextCursor }`. */
export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every list route answers `Page<T>`; anything else is a contract mismatch. */
function pageOf<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): value is ListPage<T> =>
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(guard) &&
    (value.nextCursor === null || typeof value.nextCursor === "string");
}

async function getPage<T>(
  path: string,
  guard: (value: unknown) => value is T,
  what: string,
  signal?: AbortSignal,
): Promise<ListPage<T>> {
  return expectShape(await request("GET", path, undefined, { signal }), pageOf(guard), what);
}

async function send<T>(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  body: unknown,
  guard: (value: unknown) => value is T,
  what: string,
): Promise<T> {
  return expectShape(await request(method, path, body), guard, what);
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

/** The largest page the server hands out (`?limit=` 1 to 200); pickers ask for this much. */
export const MAX_PAGE_SIZE = 200;

// Members

export interface Member {
  userId: string;
  email: string;
  name: string;
  /** A role key: a built-in name (owner, admin, editor, viewer) or a custom role id. */
  role: string;
  joinedAt: number;
  /** The member's second factor; `required` by the server or this organization. */
  secondFactor?: SecondFactorSummary | undefined;
}

/** Answers before the second factor (and the fakes of tests) leave it out. */
const optionalSummary: Check = (value) => value === undefined || isSummary(value);

const isMember = shape<Member>({
  userId: isString,
  email: isString,
  name: isString,
  role: isString,
  joinedAt: isNumber,
  secondFactor: optionalSummary,
});

export function listMembers(orgId: string, cursor?: string, limit?: number, signal?: AbortSignal) {
  const path = orgPath(orgId, `/members${query({ cursor, limit })}`);
  return getPage(path, isMember, "members", signal);
}

export function addMember(orgId: string, input: { email: string; role: string }) {
  return send("POST", orgPath(orgId, "/members"), input, isMember, "member");
}

export function changeMemberRole(orgId: string, userId: string, role: string) {
  return send("PATCH", orgPath(orgId, `/members/${enc(userId)}`), { role }, isMember, "member");
}

export async function removeMember(orgId: string, userId: string) {
  await request("DELETE", orgPath(orgId, `/members/${enc(userId)}`));
}

// Teams

export const TEAM_ROLES = ["member", "maintainer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** A team may have at most this many roles (server rule). */
export const MAX_TEAM_ROLES = 20;

export interface Team {
  id: string;
  name: string;
  /** Role keys, sorted; never "owner". */
  roles: string[];
  memberCount: number;
  createdAt: number;
}

const isTeam = shape<Team>({
  id: isString,
  name: isString,
  roles: arrayOf(isString),
  memberCount: isNumber,
  createdAt: isNumber,
});

export interface TeamMember {
  userId: string;
  email: string;
  name: string;
  role: TeamRole;
  addedAt: number;
}

const isTeamMember = shape<TeamMember>({
  userId: isString,
  email: isString,
  name: isString,
  role: oneOf(...TEAM_ROLES),
  addedAt: isNumber,
});

export function listTeams(orgId: string, cursor?: string, limit?: number) {
  return getPage(orgPath(orgId, `/teams${query({ cursor, limit })}`), isTeam, "teams");
}

export async function fetchTeam(orgId: string, teamId: string): Promise<Team> {
  return expectShape(await request("GET", orgPath(orgId, `/teams/${enc(teamId)}`)), isTeam, "team");
}

export function createTeam(orgId: string, name: string) {
  return send("POST", orgPath(orgId, "/teams"), { name }, isTeam, "team");
}

export function renameTeam(orgId: string, teamId: string, name: string) {
  return send("PATCH", orgPath(orgId, `/teams/${enc(teamId)}`), { name }, isTeam, "team");
}

/**
 * Deletes a team; what it owns (team spaces, folders, dashboards) goes to `transferTo`: another
 * team's id, or `org` for the organization.
 */
export async function deleteTeam(orgId: string, teamId: string, transferTo = "org") {
  await request("DELETE", orgPath(orgId, `/teams/${enc(teamId)}${query({ transferTo })}`));
}

export function listTeamMembers(orgId: string, teamId: string, cursor?: string) {
  const path = orgPath(orgId, `/teams/${enc(teamId)}/members${query({ cursor })}`);
  return getPage(path, isTeamMember, "team members");
}

/** Adds the member to the team, or changes their team role. */
export function putTeamMember(orgId: string, teamId: string, userId: string, role: TeamRole) {
  const path = orgPath(orgId, `/teams/${enc(teamId)}/members/${enc(userId)}`);
  return send("PUT", path, { role }, isTeamMember, "team member");
}

export async function removeTeamMember(orgId: string, teamId: string, userId: string) {
  await request("DELETE", orgPath(orgId, `/teams/${enc(teamId)}/members/${enc(userId)}`));
}

export function setTeamRoles(orgId: string, teamId: string, roles: string[]) {
  const path = orgPath(orgId, `/teams/${enc(teamId)}/roles`);
  return send("PUT", path, { roles }, isTeam, "team");
}

// Service accounts and API tokens (docs/api/access.md, "Service accounts")

export interface ServiceAccount {
  id: string;
  name: string;
  description: string;
  /** A role key; never "owner". */
  role: string;
  disabled: boolean;
  activeTokens: number;
  nextExpiry: number | null;
  lastUsedAt: number | null;
  createdByName: string | null;
  createdAt: number;
}

const serviceAccountFields = {
  id: isString,
  name: isString,
  description: isString,
  role: isString,
  disabled: isBoolean,
  activeTokens: isNumber,
  nextExpiry: nullable(isNumber),
  lastUsedAt: nullable(isNumber),
  createdByName: nullable(isString),
  createdAt: isNumber,
};

const isServiceAccount = shape<ServiceAccount>(serviceAccountFields);

export interface ApiToken {
  id: string;
  name: string;
  /** The visible start of the token; the rest is never shown again. */
  prefix: string;
  expiresAt: number;
  allowedIps: string[];
  createdAt: number;
  createdByName: string | null;
  lastUsedAt: number | null;
  lastUsedAddress: string | null;
  revokedAt: number | null;
  revokedByName: string | null;
}

const apiTokenFields = {
  id: isString,
  name: isString,
  prefix: isString,
  expiresAt: isNumber,
  allowedIps: arrayOf(isString),
  createdAt: isNumber,
  createdByName: nullable(isString),
  lastUsedAt: nullable(isNumber),
  lastUsedAddress: nullable(isString),
  revokedAt: nullable(isNumber),
  revokedByName: nullable(isString),
};

const isApiToken = shape<ApiToken>(apiTokenFields);

export interface ServiceAccountDetail extends ServiceAccount {
  tokens: ApiToken[];
}

const isServiceAccountDetail = shape<ServiceAccountDetail>({
  ...serviceAccountFields,
  tokens: arrayOf(isApiToken),
});

/** A token as it is made: the only answer that holds the token itself. */
export interface CreatedToken extends ApiToken {
  token: string;
}

const isCreatedToken = shape<CreatedToken>({ ...apiTokenFields, token: isString });

const isScimTokenState = shape<{ token: ApiToken | null }>({ token: nullable(isApiToken) });

export interface TokenInput {
  name: string;
  expiresInDays?: number;
  expiresAt?: number;
  allowedIps: string[];
}

export function listServiceAccounts(orgId: string, cursor?: string) {
  const path = orgPath(orgId, `/service-accounts${query({ cursor })}`);
  return getPage(path, isServiceAccount, "service accounts");
}

export async function fetchServiceAccount(orgId: string, accountId: string) {
  const path = orgPath(orgId, `/service-accounts/${enc(accountId)}`);
  return expectShape(await request("GET", path), isServiceAccountDetail, "service account");
}

export function createServiceAccount(
  orgId: string,
  input: { name: string; description: string; role: string },
) {
  return send(
    "POST",
    orgPath(orgId, "/service-accounts"),
    input,
    isServiceAccount,
    "service account",
  );
}

export function updateServiceAccount(
  orgId: string,
  accountId: string,
  input: { description?: string; role?: string; disabled?: boolean },
) {
  const path = orgPath(orgId, `/service-accounts/${enc(accountId)}`);
  return send("PATCH", path, input, isServiceAccount, "service account");
}

export async function deleteServiceAccount(orgId: string, accountId: string) {
  await request("DELETE", orgPath(orgId, `/service-accounts/${enc(accountId)}`));
}

export function createApiToken(orgId: string, accountId: string, input: TokenInput) {
  const path = orgPath(orgId, `/service-accounts/${enc(accountId)}/tokens`);
  return send("POST", path, input, isCreatedToken, "token");
}

export function revokeApiToken(orgId: string, accountId: string, tokenId: string) {
  const path = orgPath(orgId, `/service-accounts/${enc(accountId)}/tokens/${enc(tokenId)}/revoke`);
  return send("POST", path, {}, isApiToken, "token");
}

export async function fetchScimToken(orgId: string) {
  const answer = await request("GET", orgPath(orgId, "/scim-token"));
  return expectShape(answer, isScimTokenState, "SCIM token").token;
}

export function createScimToken(orgId: string) {
  return send("POST", orgPath(orgId, "/scim-token"), {}, isCreatedToken, "SCIM token");
}

export async function revokeScimToken(orgId: string) {
  await request("DELETE", orgPath(orgId, "/scim-token"));
}

// Roles

export interface Role {
  /** The role key: a built-in name or a custom role id. */
  id: string;
  /** Built-in roles carry their key here; the UI translates them by id. */
  name: string;
  description: string;
  builtin: boolean;
  /** Strings, not Permission: the server may know permissions newer than this UI. */
  permissions: string[];
  createdAt: number | null;
}

const isRole = shape<Role>({
  id: isString,
  name: isString,
  description: isString,
  builtin: isBoolean,
  permissions: arrayOf(isString),
  createdAt: nullable(isNumber),
});

/** An organization has at most this many custom roles (server rule). */
export const MAX_CUSTOM_ROLES = 100;
/** The longest role description the server accepts. */
export const MAX_ROLE_DESCRIPTION = 500;

export interface RoleInput {
  name: string;
  description: string;
  permissions: string[];
}

/** Every role of the organization; the server answers them as one page. */
export async function listRoles(orgId: string): Promise<Role[]> {
  return (await getPage(orgPath(orgId, "/roles"), isRole, "roles")).items;
}

export function createRole(orgId: string, input: RoleInput) {
  return send("POST", orgPath(orgId, "/roles"), input, isRole, "role");
}

export function updateRole(orgId: string, roleId: string, input: Partial<RoleInput>) {
  return send("PATCH", orgPath(orgId, `/roles/${enc(roleId)}`), input, isRole, "role");
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

/** Folders and dashboards are viewed, data sources are queried (docs/api/access.md, Grants). */
export function levelsFor(resourceType: ResourceType): readonly GrantLevel[] {
  return resourceType === "datasource" ? ["query", "edit", "admin"] : ["view", "edit", "admin"];
}

export interface Grant {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  /** User name, team name, custom role name, or the built-in role key. */
  subjectName: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
  createdAt: number;
}

const isGrant = shape<Grant>({
  id: isString,
  subjectType: oneOf(...SUBJECT_TYPES),
  subjectId: isString,
  subjectName: isString,
  resourceType: oneOf(...RESOURCE_TYPES),
  resourceId: isString,
  level: oneOf(...GRANT_LEVELS),
  createdAt: isNumber,
});

export interface GrantInput {
  subjectType: SubjectType;
  subjectId: string;
  resourceType: ResourceType;
  resourceId: string;
  level: GrantLevel;
}

/**
 * The grants on exactly this resource. Answers `forbidden` when the caller may not manage its
 * access, which is how the access dialog learns whether it may change anything.
 */
export function listGrants(
  orgId: string,
  resourceType: ResourceType,
  resourceId: string,
  cursor?: string,
) {
  const path = orgPath(orgId, `/grants${query({ resourceType, resourceId, cursor })}`);
  return getPage(path, isGrant, "grants");
}

/** Creates the grant, or changes the level of the subject's existing grant on the resource. */
export function addGrant(orgId: string, input: GrantInput) {
  return send("POST", orgPath(orgId, "/grants"), input, isGrant, "grant");
}

export async function removeGrant(orgId: string, grantId: string) {
  await request("DELETE", orgPath(orgId, `/grants/${enc(grantId)}`));
}

export type GrantSource =
  | { kind: "orgRole"; role: string }
  | { kind: "customRole"; roleId: string; roleName: string }
  | { kind: "teamRole"; teamId: string; teamName: string; role: string; roleName: string }
  | { kind: "teamOwner"; teamId: string; teamName: string }
  | {
      kind: "grant";
      grantId: string;
      subjectType: SubjectType;
      subjectId: string;
      resourceType: ResourceType;
      resourceId: string;
      level: GrantLevel;
    };

const SOURCE_CHECKS: Record<GrantSource["kind"], (value: Record<string, unknown>) => boolean> = {
  orgRole: shape<{ role: string }>({ role: isString }),
  customRole: shape<{ roleId: string; roleName: string }>({ roleId: isString, roleName: isString }),
  teamRole: shape<{ teamId: string; teamName: string; role: string; roleName: string }>({
    teamId: isString,
    teamName: isString,
    role: isString,
    roleName: isString,
  }),
  teamOwner: shape<{ teamId: string; teamName: string }>({ teamId: isString, teamName: isString }),
  grant: shape<Omit<Extract<GrantSource, { kind: "grant" }>, "kind">>({
    grantId: isString,
    subjectType: oneOf(...SUBJECT_TYPES),
    subjectId: isString,
    resourceType: oneOf(...RESOURCE_TYPES),
    resourceId: isString,
    level: oneOf(...GRANT_LEVELS),
  }),
};

function isGrantSource(value: unknown): value is GrantSource {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    Object.hasOwn(SOURCE_CHECKS, value.kind) &&
    SOURCE_CHECKS[value.kind as GrantSource["kind"]](value)
  );
}

export interface Explanation {
  permission: string;
  allowed: boolean;
  sources: GrantSource[];
}

const isExplanation = shape<Explanation>({
  permission: isString,
  allowed: isBoolean,
  sources: arrayOf(isGrantSource),
});

export async function explainPermission(
  orgId: string,
  permission: string,
  resource?: { type: ResourceType; id: string },
): Promise<Explanation> {
  const path = orgPath(
    orgId,
    `/explain${query({ permission, resourceType: resource?.type, resourceId: resource?.id })}`,
  );
  return expectShape(await request("GET", path), isExplanation, "explain");
}

// Settings (organization and server have the same shape and versioned update)

export const SETTING_SOURCES = ["env", "file", "database", "default"] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

export interface Setting {
  key: string;
  scope: "server" | "org";
  value: unknown;
  default: unknown;
  source: SettingSource;
  /** False: set in the environment or kalzit.toml, or never changeable in the UI. */
  editable: boolean;
  /** The stored version an update must name; 0 when never saved. */
  version: number;
  /** English, from the server; shown only for a key this UI has no texts for (catalog.ts). */
  description: string;
  updatedAt: number | null;
  updatedBy: string | null;
}

export const isSetting = shape<Setting>({
  key: isString,
  scope: oneOf("server", "org"),
  value: isAny,
  default: isAny,
  source: oneOf(...SETTING_SOURCES),
  editable: isBoolean,
  version: isNumber,
  description: isString,
  updatedAt: nullable(isNumber),
  updatedBy: nullable(isString),
});

export async function listOrgSettings(orgId: string): Promise<Setting[]> {
  return (await getPage(orgPath(orgId, "/settings"), isSetting, "settings")).items;
}

export function updateOrgSetting(orgId: string, key: string, value: unknown, version: number) {
  const path = orgPath(orgId, `/settings/${enc(key)}`);
  return send("PATCH", path, { value, version }, isSetting, "setting");
}

export async function listServerSettings(): Promise<Setting[]> {
  return (await getPage("/api/admin/settings", isSetting, "server settings")).items;
}

export function updateServerSetting(key: string, value: unknown, version: number) {
  const path = `/api/admin/settings/${enc(key)}`;
  return send("PATCH", path, { value, version }, isSetting, "setting");
}

// Audit

export interface AuditEvent {
  id: string;
  /** Null for server events such as sign-ins. */
  orgId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorAddress: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  /** Ids and changed field names, never secrets or typed text. */
  summary: Record<string, unknown>;
  createdAt: number;
}

const isAuditEvent = shape<AuditEvent>({
  id: isString,
  orgId: nullable(isString),
  actorUserId: nullable(isString),
  actorName: nullable(isString),
  actorAddress: nullable(isString),
  action: isString,
  resourceType: nullable(isString),
  resourceId: nullable(isString),
  summary: isRecord,
  createdAt: isNumber,
});

export interface AuditFilter {
  actor?: string | undefined;
  /** An action or an area prefix such as `team.`. */
  action?: string | undefined;
  /** Unix milliseconds, inclusive. */
  from?: number | undefined;
  /** Unix milliseconds, exclusive. */
  to?: number | undefined;
  /** Server audit log only: one organization. */
  orgId?: string | undefined;
}

/** Org audit log, or the server's when `orgId` is null. */
export function listAudit(
  orgId: string | null,
  filter: AuditFilter,
  cursor?: string,
  options: { limit?: number | undefined; signal?: AbortSignal | undefined } = {},
) {
  const base = orgId === null ? "/api/admin/audit" : orgPath(orgId, "/audit");
  const params = orgId === null ? filter : { ...filter, orgId: undefined };
  const path = `${base}${query({ ...params, cursor, limit: options.limit })}`;
  return getPage(path, isAuditEvent, "audit", options.signal);
}

// Server administration

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  /** The account's second factor; `required` by the server or any of its organizations. */
  secondFactor?: SecondFactorSummary | undefined;
}

const isAdminUser = shape<AdminUser>({
  id: isString,
  email: isString,
  name: isString,
  isServerAdmin: isBoolean,
  disabled: isBoolean,
  createdAt: isNumber,
  secondFactor: optionalSummary,
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

export function listUsers(cursor?: string, limit?: number) {
  return getPage(`/api/admin/users${query({ cursor, limit })}`, isAdminUser, "users");
}

export function createUser(input: NewUserInput) {
  return send("POST", "/api/admin/users", input, isAdminUser, "user");
}

export function updateUser(userId: string, patch: UserPatch) {
  return send("PATCH", `/api/admin/users/${enc(userId)}`, patch, isAdminUser, "user");
}

export interface AdminOrg {
  id: string;
  name: string;
  memberCount: number;
  createdAt: number;
}

const isAdminOrg = shape<AdminOrg>({
  id: isString,
  name: isString,
  memberCount: isNumber,
  createdAt: isNumber,
});

export function listOrgs(cursor?: string, limit?: number) {
  return getPage(`/api/admin/orgs${query({ cursor, limit })}`, isAdminOrg, "organizations");
}

export function createOrg(input: { name: string; ownerUserId: string }) {
  return send("POST", "/api/admin/orgs", input, isAdminOrg, "organization");
}

export function renameOrg(orgId: string, name: string) {
  return send("PATCH", `/api/admin/orgs/${enc(orgId)}`, { name }, isAdminOrg, "organization");
}

// The signed-in user's own account

export interface Session {
  id: string;
  createdAt: number;
  /** Updated at most every 5 minutes. */
  lastSeenAt: number;
  expiresAt: number;
  /** The session of this browser. */
  current: boolean;
}

const isSession = shape<Session>({
  id: isString,
  createdAt: isNumber,
  lastSeenAt: isNumber,
  expiresAt: isNumber,
  current: isBoolean,
});

export async function updateMyName(name: string) {
  await request("PATCH", "/api/me", { name });
}

/** Changes the password; the server ends every other session of the account. */
export async function changeMyPassword(input: { current: string; new: string }) {
  await request("POST", "/api/me/password", input);
}

export function listMySessions(cursor?: string) {
  return getPage(`/api/me/sessions${query({ cursor })}`, isSession, "sessions");
}

export async function revokeSession(sessionId: string) {
  await request("DELETE", `/api/me/sessions/${enc(sessionId)}`);
}

export async function revokeOtherSessions(): Promise<number> {
  const body = await request("POST", "/api/me/sessions/revoke-others");
  const revoked = isRecord(body) ? body.revoked : undefined;
  return expectShape(revoked, (value): value is number => isNumber(value), "revoke others");
}

// Query keys: everything of an organization's administration under one prefix, so a change can
// refresh what depends on it (a removed member also leaves its teams).

export const adminKeys = {
  org: (orgId: string) => ["admin", "org", orgId] as const,
  members: (orgId: string) => ["admin", "org", orgId, "members"] as const,
  teams: (orgId: string) => ["admin", "org", orgId, "teams"] as const,
  team: (orgId: string, teamId: string) => ["admin", "org", orgId, "teams", teamId] as const,
  roles: (orgId: string) => ["admin", "org", orgId, "roles"] as const,
  serviceAccounts: (orgId: string) => ["admin", "org", orgId, "service-accounts"] as const,
  serviceAccount: (orgId: string, accountId: string) =>
    ["admin", "org", orgId, "service-accounts", accountId] as const,
  scimToken: (orgId: string) => ["admin", "org", orgId, "scim-token"] as const,
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
