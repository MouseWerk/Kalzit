/**
 * Calls of Verwaltung > Anmeldung (docs/api/sso.md): identity providers with their connection
 * check and test sign-in, group mappings with the rule for people without a matching group, and
 * the local password sign-in with its break-glass admin. Server admins only. Answers are checked
 * like the other administration calls, so a mismatch fails as `invalid_response`.
 */
import { expectShape, isRecord, request } from "../../../api/client";

const enc = encodeURIComponent;

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isStringOrNull = (value: unknown) => value === null || isString(value);
const isNumberOrNull = (value: unknown) => value === null || isNumber(value);

function has(value: unknown, checks: Record<string, (field: unknown) => boolean>): boolean {
  return isRecord(value) && Object.entries(checks).every(([name, check]) => check(value[name]));
}

/** The roles a group mapping may give (`owner` is never mapped). */
export const MAPPING_ROLES = ["viewer", "editor", "admin"] as const;
export type MappingRole = (typeof MAPPING_ROLES)[number];

/** The default role of people without a matching group. */
export const DEFAULT_ROLES = ["viewer", "editor"] as const;
export type DefaultRole = (typeof DEFAULT_ROLES)[number];

export type PasswordFormMode = "expanded" | "collapsed" | "hidden";

// Providers

export interface ProviderSummary {
  id: string;
  slug: string;
  kind: string;
  name: string;
  issuer: string;
  position: number;
  enabled: boolean;
  people: number;
  lastSignInAt: number | null;
  checkedAt: number | null;
  createAccounts: boolean;
  trustProviderMfa: boolean;
  redirectUri: string;
  /** LDAP only: `ad` or `ldap`, when the server says (for the label in the list). */
  flavor?: string | undefined;
}

const PROVIDER_SUMMARY = {
  id: isString,
  slug: isString,
  kind: isString,
  name: isString,
  issuer: isString,
  position: isNumber,
  enabled: isBoolean,
  people: isNumber,
  lastSignInAt: isNumberOrNull,
  checkedAt: isNumberOrNull,
  createAccounts: isBoolean,
  trustProviderMfa: isBoolean,
  redirectUri: isString,
};

export interface SignInOverview {
  providers: ProviderSummary[];
  /** All enabled accounts. */
  accounts: number;
  /** Enabled accounts with an identity at an enabled provider. */
  viaProviders: number;
  /** The start of the redirect URI of a provider not saved yet. */
  redirectBase: string;
}

function isOverview(value: unknown): value is SignInOverview {
  return has(value, {
    providers: (list) => Array.isArray(list) && list.every((item) => has(item, PROVIDER_SUMMARY)),
    accounts: isNumber,
    viaProviders: isNumber,
    redirectBase: isString,
  });
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  scopes: string[];
  groupsClaim: string;
  emailClaim: string;
  nameClaim: string;
  pkce: boolean;
  trustEmail: boolean;
}

export interface Provider {
  id: string;
  slug: string;
  kind: string;
  name: string;
  enabled: boolean;
  position: number;
  version: number;
  createAccounts: boolean;
  trustProviderMfa: boolean;
  redirectUri: string;
  oidc: OidcSettings;
}

function isProvider(value: unknown): value is Provider {
  return has(value, {
    id: isString,
    slug: isString,
    kind: isString,
    name: isString,
    enabled: isBoolean,
    position: isNumber,
    version: isNumber,
    createAccounts: isBoolean,
    trustProviderMfa: isBoolean,
    redirectUri: isString,
    oidc: (oidc) =>
      has(oidc, {
        issuer: isString,
        clientId: isString,
        clientSecretSet: isBoolean,
        scopes: (scopes) => Array.isArray(scopes) && scopes.every(isString),
        groupsClaim: isString,
        emailClaim: isString,
        nameClaim: isString,
        pkce: isBoolean,
        trustEmail: isBoolean,
      }),
  });
}

/** The form of a provider (`ProviderInput`); `clientSecret` left out keeps the stored one. */
export interface ProviderInput {
  kind: "oidc";
  slug: string;
  name: string;
  createAccounts: boolean;
  trustProviderMfa: boolean;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    scopes: string[];
    groupsClaim: string;
    emailClaim: string;
    nameClaim: string;
    pkce: boolean;
    trustEmail: boolean;
  };
}

export interface ProviderCheck {
  checkToken: string;
  keys: number;
  durationMs: number;
  /** Null when the provider's answer did not say. */
  clientAccepted: boolean | null;
}

function isCheck(value: unknown): value is ProviderCheck {
  return has(value, {
    checkToken: isString,
    keys: isNumber,
    durationMs: isNumber,
    clientAccepted: (accepted) => accepted === null || isBoolean(accepted),
  });
}

export async function fetchSignInOverview(): Promise<SignInOverview> {
  return expectShape(await request("GET", "/api/admin/sign-in"), isOverview, "sign-in");
}

export async function fetchProvider(providerId: string): Promise<Provider> {
  return expectShape(
    await request("GET", `/api/admin/sign-in/providers/${enc(providerId)}`),
    isProvider,
    "provider",
  );
}

export async function checkProvider(
  input: ProviderInput,
  providerId: string | undefined,
): Promise<ProviderCheck> {
  const body = providerId === undefined ? input : { ...input, providerId };
  return expectShape(
    await request("POST", "/api/admin/sign-in/providers/check", body),
    isCheck,
    "provider check",
  );
}

export async function createProvider(input: ProviderInput, checkToken: string): Promise<Provider> {
  return expectShape(
    await request("POST", "/api/admin/sign-in/providers", { ...input, checkToken }),
    isProvider,
    "provider",
  );
}

export async function updateProvider(
  providerId: string,
  input: ProviderInput,
  version: number,
  checkToken: string | undefined,
  confirmIssuerChange = false,
): Promise<Provider> {
  const base = confirmIssuerChange
    ? { ...input, version, confirmIssuerChange }
    : { ...input, version };
  const body = checkToken === undefined ? base : { ...base, checkToken };
  return expectShape(
    await request("PUT", `/api/admin/sign-in/providers/${enc(providerId)}`, body),
    isProvider,
    "provider",
  );
}

export async function setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
  await request("PATCH", `/api/admin/sign-in/providers/${enc(providerId)}/enabled`, { enabled });
}

export async function setProviderOrder(ids: readonly string[]): Promise<void> {
  await request("PUT", "/api/admin/sign-in/order", { ids });
}

export async function deleteProvider(providerId: string): Promise<void> {
  await request("DELETE", `/api/admin/sign-in/providers/${enc(providerId)}`);
}

// Test sign-in

export interface OutcomeOrg {
  orgId: string;
  orgName: string;
  role: string;
  group: string | null;
  teams: { teamId: string; teamName: string }[];
  idpDecides: boolean;
  /** The default role of the rule for people without a matching group. */
  default: boolean;
}

export interface Outcome {
  refused: boolean;
  orgs: OutcomeOrg[];
}

function isOutcome(value: unknown): value is Outcome {
  return has(value, {
    refused: isBoolean,
    orgs: (orgs) =>
      Array.isArray(orgs) &&
      orgs.every((org) =>
        has(org, {
          orgId: isString,
          orgName: isString,
          role: isString,
          group: isStringOrNull,
          teams: (teams) =>
            Array.isArray(teams) &&
            teams.every((team) => has(team, { teamId: isString, teamName: isString })),
          idpDecides: isBoolean,
          default: isBoolean,
        }),
      ),
  });
}

export interface TestSignInStart {
  id: string;
  url: string;
}

export interface TestSignInResult {
  subject: string;
  username: string;
  email: string;
  groups: string[];
  outcome: Outcome;
}

export interface TestSignIn {
  status: "pending" | "done" | "failed";
  result?: TestSignInResult | undefined;
  error?: { reason: string; message: string } | undefined;
}

function isTestSignIn(value: unknown): value is TestSignIn {
  if (!isRecord(value) || !["pending", "done", "failed"].includes(String(value.status))) {
    return false;
  }
  if (value.status === "done") {
    return has(value.result, {
      subject: isString,
      username: isString,
      email: isString,
      groups: (groups) => Array.isArray(groups) && groups.every(isString),
      outcome: isOutcome,
    });
  }
  if (value.status === "failed") {
    return has(value.error, { reason: isString, message: isString });
  }
  return true;
}

export async function startTestSignIn(
  input: ProviderInput,
  providerId: string | undefined,
  checkToken: string,
): Promise<TestSignInStart> {
  const body =
    providerId === undefined ? { ...input, checkToken } : { ...input, providerId, checkToken };
  return expectShape(
    await request("POST", "/api/admin/sign-in/test-sign-ins", body),
    (value): value is TestSignInStart => has(value, { id: isString, url: isString }),
    "test sign-in",
  );
}

export async function fetchTestSignIn(testId: string): Promise<TestSignIn> {
  return expectShape(
    await request("GET", `/api/admin/sign-in/test-sign-ins/${enc(testId)}`),
    isTestSignIn,
    "test sign-in",
  );
}

// LDAP and Active Directory (docs/api/sso.md, "LDAP and Active Directory")

export type LdapFlavor = "ad" | "ldap";
export type LdapEncryption = "ldaps" | "starttls" | "none";
export type LdapSchedule = "daily" | "every6h" | "off";

/** The login attributes each flavor offers. */
export const LOGIN_ATTRIBUTES: Record<LdapFlavor, readonly string[]> = {
  ad: ["sAMAccountName", "userPrincipalName", "mail"],
  ldap: ["uid", "mail", "cn"],
};

/** The fields of an LDAP provider as stored, without the bind password. */
export interface LdapFields {
  flavor: LdapFlavor;
  url: string;
  encryption: LdapEncryption;
  certificate: "system" | "custom";
  caPem: string | null;
  bindDn: string;
  userBaseDn: string;
  loginAttribute: string;
  userFilter: string;
  groupBaseDn: string;
  nestedGroups: boolean;
  emailAttribute: string;
  nameAttribute: string;
  trustEmail: boolean;
  syncSchedule: LdapSchedule;
  syncHour: number;
  syncThreshold: number;
}

export interface LdapSettings extends LdapFields {
  bindPasswordSet: boolean;
}

export interface LdapProvider {
  id: string;
  slug: string;
  kind: "ldap";
  name: string;
  enabled: boolean;
  position: number;
  version: number;
  createAccounts: boolean;
  ldap: LdapSettings;
}

const isTextOrEmpty = (value: unknown) => value === undefined || isStringOrNull(value);

function isLdapSettings(value: unknown): value is LdapSettings {
  return has(value, {
    flavor: (flavor) => flavor === "ad" || flavor === "ldap",
    url: isString,
    encryption: (mode) => mode === "ldaps" || mode === "starttls" || mode === "none",
    certificate: (mode) => mode === "system" || mode === "custom",
    caPem: isTextOrEmpty,
    bindDn: isString,
    bindPasswordSet: isBoolean,
    userBaseDn: isString,
    loginAttribute: isString,
    // Empty values may come as null or be left out.
    userFilter: isTextOrEmpty,
    groupBaseDn: isTextOrEmpty,
    nestedGroups: isBoolean,
    emailAttribute: isString,
    nameAttribute: isString,
    trustEmail: isBoolean,
    syncSchedule: (mode) => mode === "daily" || mode === "every6h" || mode === "off",
    syncHour: isNumber,
    syncThreshold: isNumber,
  });
}

function isLdapProvider(value: unknown): value is LdapProvider {
  return has(value, {
    id: isString,
    slug: isString,
    kind: (kind) => kind === "ldap",
    name: isString,
    enabled: isBoolean,
    position: isNumber,
    version: isNumber,
    createAccounts: isBoolean,
    ldap: isLdapSettings,
  });
}

/** An LDAP provider as the form starts from it: empty values as empty text. */
function normalized(provider: LdapProvider): LdapProvider {
  return {
    ...provider,
    ldap: {
      ...provider.ldap,
      caPem: provider.ldap.caPem ?? null,
      userFilter: provider.ldap.userFilter ?? "",
      groupBaseDn: provider.ldap.groupBaseDn ?? "",
    },
  };
}

/** The form of an LDAP provider (`LdapInput`); `bindPassword` left out keeps the stored one. */
export interface LdapInput {
  slug: string;
  name: string;
  createAccounts: boolean;
  ldap: LdapFields & { bindPassword?: string };
}

export interface LdapTestPerson {
  dn: string;
  login: string;
  email: string | null;
  name: string | null;
  disabled: boolean;
  bound: boolean;
  groups: string[];
  outcome: Outcome;
}

export interface LdapCheck {
  checkToken: string;
  durationMs: number;
  /** "LDAPS" or "StartTLS"; null for an unencrypted connection. */
  tls: string | null;
  sample: { users: string[]; groups: string[] };
  test: LdapTestPerson | null;
}

const isStrings = (value: unknown) => Array.isArray(value) && value.every(isString);

function isLdapCheck(value: unknown): value is LdapCheck {
  return has(value, {
    checkToken: isString,
    durationMs: isNumber,
    tls: isStringOrNull,
    sample: (sample) => has(sample, { users: isStrings, groups: isStrings }),
    test: (test) =>
      test === null ||
      test === undefined ||
      has(test, {
        dn: isString,
        login: isString,
        email: isStringOrNull,
        name: isStringOrNull,
        disabled: isBoolean,
        bound: isBoolean,
        groups: isStrings,
        outcome: isOutcome,
      }),
  });
}

export async function fetchLdapProvider(providerId: string): Promise<LdapProvider> {
  const provider = expectShape(
    await request("GET", `/api/admin/sign-in/providers/${enc(providerId)}`),
    isLdapProvider,
    "provider",
  );
  return normalized(provider);
}

/** The connection check, with the optional test person ("Testanmeldung mit"). */
export async function checkLdap(
  input: LdapInput,
  providerId: string | undefined,
  test: { login: string; password: string },
): Promise<LdapCheck> {
  const body: Record<string, unknown> = { ...input };
  if (providerId !== undefined) {
    body.providerId = providerId;
  }
  if (test.login !== "") {
    body.testLogin = test.login;
    if (test.password !== "") {
      body.testPassword = test.password;
    }
  }
  const answer = expectShape(
    await request("POST", "/api/admin/sign-in/ldap/check", body),
    isLdapCheck,
    "provider check",
  );
  return { ...answer, test: answer.test ?? null };
}

export async function createLdap(input: LdapInput, checkToken: string): Promise<LdapProvider> {
  return expectShape(
    await request("POST", "/api/admin/sign-in/ldap", { ...input, checkToken }),
    isLdapProvider,
    "provider",
  );
}

export async function updateLdap(
  providerId: string,
  input: LdapInput,
  version: number,
  checkToken: string | undefined,
): Promise<LdapProvider> {
  const body = checkToken === undefined ? { ...input, version } : { ...input, version, checkToken };
  return expectShape(
    await request("PUT", `/api/admin/sign-in/ldap/${enc(providerId)}`, body),
    isLdapProvider,
    "provider",
  );
}

// LDAP sync

export type SyncStatus = "running" | "done" | "halted" | "failed" | "applied";

export interface SyncRun {
  id: string;
  trigger: "schedule" | "manual" | "apply";
  status: SyncStatus;
  startedAt: number;
  finishedAt: number | null;
  checked: number;
  changed: number;
  deactivated: number;
  reactivated: number;
  skipped: number;
  wouldDeactivate: number;
  accounts: number;
  threshold: number;
  error: string | null;
  appliedBy: string | null;
  appliedAt: number | null;
}

/** A person a sync disabled or would disable, with the reason (`not_in_directory`, ...). */
export interface SyncPerson {
  userId: string;
  name: string;
  email: string;
  login: string | null;
  reason: string;
}

export interface Deactivated extends SyncPerson {
  at: number;
}

export interface SyncState {
  schedule: LdapSchedule;
  hour: number;
  threshold: number;
  nextRunAt: number | null;
  failuresInRow: number;
  runs: SyncRun[];
  deactivated: Deactivated[];
}

export interface SyncRunDetail extends SyncRun {
  pending: SyncPerson[];
}

const SYNC_STATUSES: readonly string[] = ["running", "done", "halted", "failed", "applied"];

function isSyncRun(value: unknown): value is SyncRun {
  return has(value, {
    id: isString,
    trigger: (trigger) => trigger === "schedule" || trigger === "manual" || trigger === "apply",
    status: (status) => typeof status === "string" && SYNC_STATUSES.includes(status),
    startedAt: isNumber,
    finishedAt: isNumberOrNull,
    checked: isNumber,
    changed: isNumber,
    deactivated: isNumber,
    reactivated: isNumber,
    skipped: isNumber,
    wouldDeactivate: isNumber,
    accounts: isNumber,
    threshold: isNumber,
    error: isStringOrNull,
    appliedBy: isStringOrNull,
    appliedAt: isNumberOrNull,
  });
}

const SYNC_PERSON = {
  userId: isString,
  name: isString,
  email: isString,
  login: isTextOrEmpty,
  reason: isString,
};

function isSyncState(value: unknown): value is SyncState {
  return has(value, {
    schedule: (mode) => mode === "daily" || mode === "every6h" || mode === "off",
    hour: isNumber,
    threshold: isNumber,
    nextRunAt: isNumberOrNull,
    failuresInRow: isNumber,
    runs: (runs) => Array.isArray(runs) && runs.every(isSyncRun),
    deactivated: (list) =>
      Array.isArray(list) && list.every((item) => has(item, { ...SYNC_PERSON, at: isNumber })),
  });
}

function isSyncRunDetail(value: unknown): value is SyncRunDetail {
  return (
    isSyncRun(value) &&
    has(value, {
      pending: (list) => Array.isArray(list) && list.every((item) => has(item, SYNC_PERSON)),
    })
  );
}

function syncPath(providerId: string): string {
  return `/api/admin/sign-in/providers/${enc(providerId)}/sync`;
}

export async function fetchSync(providerId: string): Promise<SyncState> {
  return expectShape(await request("GET", syncPath(providerId)), isSyncState, "sync");
}

/** "Jetzt abgleichen": runs a sync now and answers it. */
export async function runSync(providerId: string): Promise<SyncRun> {
  return expectShape(await request("POST", syncPath(providerId)), isSyncRun, "sync run");
}

export async function fetchSyncRun(providerId: string, runId: string): Promise<SyncRunDetail> {
  return expectShape(
    await request("GET", `${syncPath(providerId)}/runs/${enc(runId)}`),
    isSyncRunDetail,
    "sync run",
  );
}

/** "Trotzdem anwenden": needs a second factor confirmed in this session within 5 minutes. */
export async function applySyncRun(providerId: string, runId: string): Promise<SyncRun> {
  return expectShape(
    await request("POST", `${syncPath(providerId)}/runs/${enc(runId)}/apply`),
    isSyncRun,
    "sync run",
  );
}

// Group mappings

export interface Mapping {
  id: string;
  providerId: string;
  providerName: string;
  group: string;
  orgId: string;
  orgName: string;
  teamId: string | null;
  teamName: string | null;
  role: string;
  idpDecides: boolean;
  people: number;
}

const MAPPING = {
  id: isString,
  providerId: isString,
  providerName: isString,
  group: isString,
  orgId: isString,
  orgName: isString,
  teamId: isStringOrNull,
  teamName: isStringOrNull,
  role: isString,
  idpDecides: isBoolean,
  people: isNumber,
};

function isMapping(value: unknown): value is Mapping {
  return has(value, MAPPING);
}

export interface Unmapped {
  rule: "default" | "refuse";
  defaultOrgId: string | null;
  defaultRole: DefaultRole;
}

function isUnmapped(value: unknown): value is Unmapped {
  return has(value, {
    rule: (rule) => rule === "default" || rule === "refuse",
    defaultOrgId: isStringOrNull,
    defaultRole: (role) => role === "viewer" || role === "editor",
  });
}

/** An organization with its teams, to choose from in a mapping (server admins need not be members). */
export interface MappingOrg {
  id: string;
  name: string;
  teams: { id: string; name: string }[];
}

export interface Mappings {
  mappings: Mapping[];
  unmapped: Unmapped;
  orgs: MappingOrg[];
}

function isMappingOrg(value: unknown): value is MappingOrg {
  return has(value, {
    id: isString,
    name: isString,
    teams: (teams) =>
      Array.isArray(teams) && teams.every((team) => has(team, { id: isString, name: isString })),
  });
}

export interface MappingInput {
  providerId: string;
  group: string;
  orgId: string;
  teamId: string | null;
  role: MappingRole;
  idpDecides: boolean;
}

export async function fetchMappings(): Promise<Mappings> {
  return expectShape(
    await request("GET", "/api/admin/sign-in/mappings"),
    (value): value is Mappings =>
      has(value, {
        mappings: (list) => Array.isArray(list) && list.every(isMapping),
        unmapped: isUnmapped,
        orgs: (list) => Array.isArray(list) && list.every(isMappingOrg),
      }),
    "mappings",
  );
}

/** A new mapping; a mapping without a team leaves `teamId` out. */
export async function createMapping(input: MappingInput): Promise<Mapping> {
  const { teamId, ...rest } = input;
  const body = teamId === null ? rest : input;
  return expectShape(
    await request("POST", "/api/admin/sign-in/mappings", body),
    isMapping,
    "mapping",
  );
}

export async function updateMapping(
  mappingId: string,
  patch: Partial<MappingInput>,
): Promise<Mapping> {
  return expectShape(
    await request("PATCH", `/api/admin/sign-in/mappings/${enc(mappingId)}`, patch),
    isMapping,
    "mapping",
  );
}

export async function deleteMapping(mappingId: string): Promise<void> {
  await request("DELETE", `/api/admin/sign-in/mappings/${enc(mappingId)}`);
}

export async function setUnmapped(unmapped: Unmapped): Promise<void> {
  await request("PUT", "/api/admin/sign-in/unmapped", unmapped);
}

export interface MappingPreview {
  groups: { providerId: string; providerName: string; groups: string[] }[];
  outcome: Outcome;
}

export async function previewMapping(userId: string): Promise<MappingPreview> {
  return expectShape(
    await request("POST", "/api/admin/sign-in/mappings/preview", { userId }),
    (value): value is MappingPreview =>
      has(value, {
        groups: (list) =>
          Array.isArray(list) &&
          list.every((item) =>
            has(item, {
              providerId: isString,
              providerName: isString,
              groups: (groups) => Array.isArray(groups) && groups.every(isString),
            }),
          ),
        outcome: isOutcome,
      }),
    "mapping preview",
  );
}

// Local sign-in

export interface LocalChecks {
  providerReady: { ok: boolean; name?: string | undefined };
  breakGlassReady: { ok: boolean };
  selfViaProvider: { ok: boolean };
  passwordOnlyAccounts: number;
}

export interface LocalSignIn {
  localPassword: "on" | "off";
  passwordForm: PasswordFormMode;
  breakGlass: { userId: string; name: string; email: string } | null;
  /** The environment or kalzit.toml sets one of the settings. */
  readOnly: boolean;
  checks: LocalChecks;
}

function isLocal(value: unknown): value is LocalSignIn {
  const ok = (check: unknown) => has(check, { ok: isBoolean });
  return has(value, {
    localPassword: (mode) => mode === "on" || mode === "off",
    passwordForm: (form) => form === "expanded" || form === "collapsed" || form === "hidden",
    breakGlass: (user) =>
      user === null || has(user, { userId: isString, name: isString, email: isString }),
    readOnly: isBoolean,
    checks: (checks) =>
      has(checks, {
        providerReady: ok,
        breakGlassReady: ok,
        selfViaProvider: ok,
        passwordOnlyAccounts: isNumber,
      }),
  });
}

export interface LocalInput {
  localPassword: "on" | "off";
  passwordForm: PasswordFormMode;
  breakGlassUserId: string | null;
}

export async function fetchLocalSignIn(): Promise<LocalSignIn> {
  return expectShape(await request("GET", "/api/admin/sign-in/local"), isLocal, "local sign-in");
}

export async function setLocalSignIn(input: LocalInput): Promise<void> {
  await request("PUT", "/api/admin/sign-in/local", input);
}

export const ssoKeys = {
  all: ["sso"] as const,
  overview: ["sso", "overview"] as const,
  provider: (id: string) => ["sso", "provider", id] as const,
  mappings: ["sso", "mappings"] as const,
  local: ["sso", "local"] as const,
  test: (id: string) => ["sso", "test", id] as const,
  sync: (id: string) => ["sso", "sync", id] as const,
  syncRun: (id: string, runId: string) => ["sso", "sync", id, runId] as const,
};
