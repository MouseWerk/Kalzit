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
};
