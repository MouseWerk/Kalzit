import type { FakeArea, FakeServer } from "../../../../test/fakeServer";
import { error, json } from "../../../../test/fakeServer";
import type {
  LdapSettings,
  LocalChecks,
  Mapping,
  OidcSettings,
  PasswordFormMode,
  ProviderSummary,
  SamlSettings,
  SyncPerson,
  SyncRun,
  SyncState,
  TestSignIn,
  Unmapped,
} from "../api";

/**
 * The sign-in routes of docs/api/sso.md for tests: the public provider list and the local
 * sign-in, and the administration of providers, mappings and the local sign-in. It keeps what the
 * UI sends and answers the documented shapes; the OIDC flow itself is the server's own test.
 */
export interface FakeProvider extends ProviderSummary {
  version: number;
  oidc: OidcSettings;
  secret: string;
  /** LDAP providers only (`kind: "ldap"`). */
  ldap?: LdapSettings | undefined;
  /** SAML providers only (`kind: "saml"`). */
  saml?: SamlSettings | undefined;
}

/** The sync of an LDAP provider: its state and the lists of halted runs. */
export interface FakeSync extends SyncState {
  pending: Record<string, SyncPerson[]>;
}

export interface FakeSsoState {
  providers: FakeProvider[];
  accounts: number;
  viaProviders: number;
  redirectBase: string;
  passwordForm: PasswordFormMode;
  localPassword: "on" | "off";
  breakGlass: { userId: string; name: string; email: string } | null;
  readOnly: boolean;
  checks: LocalChecks;
  mappings: Mapping[];
  unmapped: Unmapped;
  /** Emails whose password sign-in is off (`sso.password_sign_in_off` after a right password). */
  passwordOff: Set<string>;
  /** Answers the next connection check with this refusal instead of success. */
  checkRefusal: { field: string; reason: string; params?: Record<string, string> } | null;
  /** What `GET /admin/sign-in/test-sign-ins/{id}` answers. */
  testAnswer: TestSignIn;
  /** The bodies of every connection check, for asserting what the form sent. */
  checksSent: unknown[];
  /** The bodies of LDAP creates and changes. */
  ldapSaved: Record<string, unknown>[];
  /** `server.public_url` as the overview reports it (`samlBase`). */
  samlBase: string | null;
  /** The bodies of SAML creates and changes. */
  samlSaved: Record<string, unknown>[];
  /** The bodies of SAML test sign-ins started. */
  samlTests: Record<string, unknown>[];
  /**
   * How a directory answers `POST /auth/login` with a user name: `ok` signs the test user in,
   * `unreachable` and a refusal answer as docs/api/sso.md says.
   */
  directoryAnswer: "ok" | "unreachable" | { outcome: string; ref: string };
  /** The sync of each LDAP provider, by id. */
  syncs: Record<string, FakeSync>;
}

const T0 = Date.UTC(2026, 9, 29, 9);

export function sampleProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  return {
    id: "p1",
    slug: "mueller-sso",
    kind: "oidc",
    name: "Müller SSO",
    issuer: "https://sso.example/realms/kalzit",
    position: 0,
    enabled: true,
    people: 3,
    lastSignInAt: T0,
    checkedAt: T0,
    createAccounts: true,
    trustProviderMfa: false,
    redirectUri: "https://kalzit.example/auth/oidc/mueller-sso/callback",
    version: 1,
    secret: "s3cret",
    oidc: {
      issuer: "https://sso.example/realms/kalzit",
      clientId: "kalzit",
      clientSecretSet: true,
      scopes: ["openid", "email", "profile", "groups"],
      groupsClaim: "groups",
      emailClaim: "email",
      nameClaim: "name",
      pkce: true,
      trustEmail: false,
    },
    ...overrides,
  };
}

export function sampleLdapProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  return sampleProvider({
    id: "l1",
    slug: "zentrale",
    kind: "ldap",
    name: "Verzeichnis Zentrale",
    issuer: "ldaps://dc01.example:636",
    flavor: "ad",
    redirectUri: "",
    secret: "bind-secret",
    ldap: {
      flavor: "ad",
      url: "ldaps://dc01.example:636",
      encryption: "ldaps",
      certificate: "system",
      caPem: null,
      bindDn: "CN=svc-kalzit,OU=Dienste,DC=example",
      bindPasswordSet: true,
      userBaseDn: "OU=Mitarbeitende,DC=example",
      loginAttribute: "sAMAccountName",
      userFilter: "",
      groupBaseDn: "",
      nestedGroups: false,
      emailAttribute: "mail",
      nameAttribute: "displayName",
      trustEmail: true,
      syncSchedule: "daily",
      syncHour: 2,
      syncThreshold: 10,
    },
    ...overrides,
  });
}

/** A pinned certificate (base64 DER) as the fake's metadata names it. */
export const SAMPLE_CERT = "MIIBszCCAVmgAwIBAgIUSAMPLE";

export function sampleSamlProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  return sampleProvider({
    id: "s1",
    slug: "partnerportal",
    kind: "saml",
    name: "Partnerportal",
    issuer: "https://idp.partnerportal.example/saml",
    redirectUri: "https://kalzit.example/auth/saml/partnerportal/acs",
    saml: {
      metadataUrl: "https://idp.partnerportal.example/saml/metadata.xml",
      idpEntityId: "https://idp.partnerportal.example/saml",
      ssoUrl: "https://idp.partnerportal.example/saml/sso",
      certificates: [SAMPLE_CERT],
      certificateInfo: [
        {
          fingerprint: "AB:CD:EF",
          subject: "CN=idp.partnerportal.example",
          notAfter: Date.UTC(2027, 5, 1),
          expired: false,
        },
      ],
      emailAttribute: "mail",
      nameAttribute: "displayName",
      groupsAttribute: "memberOf",
      trustEmail: false,
    },
    ...overrides,
  });
}

export function sampleSyncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: "r1",
    trigger: "schedule",
    status: "done",
    startedAt: T0,
    finishedAt: T0 + 41_000,
    checked: 412,
    changed: 6,
    deactivated: 3,
    reactivated: 0,
    skipped: 0,
    wouldDeactivate: 3,
    accounts: 120,
    threshold: 10,
    error: null,
    appliedBy: null,
    appliedAt: null,
    ...overrides,
  };
}

export function sampleSync(overrides: Partial<FakeSync> = {}): FakeSync {
  return {
    schedule: "daily",
    hour: 2,
    threshold: 10,
    nextRunAt: T0 + 86_400_000,
    failuresInRow: 0,
    runs: [sampleSyncRun()],
    deactivated: [],
    pending: {},
    ...overrides,
  };
}

export function sampleMapping(overrides: Partial<Mapping> = {}): Mapping {
  return {
    id: "m1",
    providerId: "p1",
    providerName: "Müller SSO",
    group: "controlling",
    orgId: "o1",
    orgName: "Analytical Engines",
    teamId: null,
    teamName: null,
    role: "editor",
    idpDecides: false,
    people: 12,
    ...overrides,
  };
}

function initialState(): FakeSsoState {
  return {
    providers: [],
    accounts: 10,
    viaProviders: 0,
    redirectBase: "https://kalzit.example",
    passwordForm: "collapsed",
    localPassword: "on",
    breakGlass: null,
    readOnly: false,
    checks: {
      providerReady: { ok: false },
      breakGlassReady: { ok: false },
      selfViaProvider: { ok: false },
      passwordOnlyAccounts: 10,
    },
    mappings: [],
    unmapped: { rule: "default", defaultOrgId: null, defaultRole: "viewer" },
    passwordOff: new Set(),
    checkRefusal: null,
    testAnswer: {
      status: "done",
      result: {
        subject: "f3a1",
        username: "l.hoffmann",
        email: "lea@example.com",
        groups: ["kalzit-admins", "vertrieb-analyse"],
        outcome: {
          refused: false,
          orgs: [
            {
              orgId: "o1",
              orgName: "Analytical Engines",
              role: "admin",
              group: "kalzit-admins",
              teams: [],
              idpDecides: true,
              default: false,
            },
          ],
        },
      },
    },
    checksSent: [],
    ldapSaved: [],
    samlBase: "https://kalzit.example",
    samlSaved: [],
    samlTests: [],
    directoryAnswer: "ok",
    syncs: {},
  };
}

/** The area's state; its routes are answered by `handleSsoRoute` (some are public). */
export function ssoFake(): FakeArea<FakeSsoState> {
  return { state: initialState(), handle: () => undefined };
}

function refusal(
  status: number,
  code: string,
  reason: string,
  field?: string,
  params?: Record<string, unknown>,
): Response {
  return json(status, {
    error: {
      code,
      message: `server message for ${reason}`,
      reason,
      ...(field === undefined ? {} : { field }),
      ...(params === undefined ? {} : { params }),
    },
  });
}

function summary(provider: FakeProvider): ProviderSummary {
  const {
    version: _version,
    oidc: _oidc,
    secret: _secret,
    ldap: _ldap,
    saml: _saml,
    ...rest
  } = provider;
  return rest;
}

function samlAddresses(base: string | null, slug: string) {
  const entity = base === null ? null : `${base}/auth/saml/${slug}`;
  return {
    spEntityId: entity,
    acsUrl: entity === null ? null : `${entity}/acs`,
    spMetadataUrl: entity === null ? null : `${entity}/metadata`,
  };
}

function detail(provider: FakeProvider, samlBase: string | null = "https://kalzit.example") {
  if (provider.kind === "saml") {
    return {
      ...samlAddresses(samlBase, provider.slug),
      id: provider.id,
      slug: provider.slug,
      kind: provider.kind,
      name: provider.name,
      enabled: provider.enabled,
      position: provider.position,
      version: provider.version,
      createAccounts: provider.createAccounts,
      trustProviderMfa: provider.trustProviderMfa,
      checkedAt: provider.checkedAt,
      saml: provider.saml,
    };
  }
  if (provider.kind === "ldap") {
    return {
      id: provider.id,
      slug: provider.slug,
      kind: provider.kind,
      name: provider.name,
      enabled: provider.enabled,
      position: provider.position,
      version: provider.version,
      createAccounts: provider.createAccounts,
      ldap: provider.ldap,
    };
  }
  return {
    id: provider.id,
    slug: provider.slug,
    kind: provider.kind,
    name: provider.name,
    enabled: provider.enabled,
    position: provider.position,
    version: provider.version,
    createAccounts: provider.createAccounts,
    trustProviderMfa: provider.trustProviderMfa,
    redirectUri: provider.redirectUri,
    oidc: provider.oidc,
  };
}

function ordered(state: FakeSsoState): FakeProvider[] {
  return [...state.providers].sort((a, b) => a.position - b.position);
}

type Input = Record<string, unknown>;

/** The provider form as stored: `ProviderInput` into the fake's provider. */
function fromInput(state: FakeSsoState, input: Input, id: string, previous?: FakeProvider) {
  const oidc = (input.oidc ?? {}) as Input;
  const slug = String(input.slug);
  return sampleProvider({
    id,
    slug,
    name: String(input.name),
    issuer: String(oidc.issuer),
    position: previous?.position ?? state.providers.length,
    enabled: previous?.enabled ?? true,
    people: previous?.people ?? 0,
    lastSignInAt: previous?.lastSignInAt ?? null,
    checkedAt: T0,
    createAccounts: Boolean(input.createAccounts),
    trustProviderMfa: Boolean(input.trustProviderMfa),
    redirectUri: `${state.redirectBase}/auth/oidc/${slug}/callback`,
    version: (previous?.version ?? 0) + 1,
    secret: typeof oidc.clientSecret === "string" ? oidc.clientSecret : (previous?.secret ?? ""),
    oidc: {
      issuer: String(oidc.issuer),
      clientId: String(oidc.clientId),
      clientSecretSet: true,
      scopes: (oidc.scopes as string[]) ?? [],
      groupsClaim: String(oidc.groupsClaim),
      emailClaim: String(oidc.emailClaim),
      nameClaim: String(oidc.nameClaim),
      pkce: Boolean(oidc.pkce),
      trustEmail: Boolean(oidc.trustEmail),
    },
  });
}

/** Check tokens the fake handed out, by the issuer, client id and secret they hold for. */
const tokens = new Map<string, string>();

function connectionOf(input: Input, stored: FakeProvider | undefined): string {
  const oidc = (input.oidc ?? {}) as Input;
  const secret = typeof oidc.clientSecret === "string" ? oidc.clientSecret : (stored?.secret ?? "");
  return JSON.stringify([oidc.issuer, oidc.clientId, secret]);
}

/** The LDAP form as stored: `LdapInput` into the fake's provider. */
function fromLdapInput(state: FakeSsoState, input: Input, id: string, previous?: FakeProvider) {
  const ldap = (input.ldap ?? {}) as Input;
  const { bindPassword, ...fields } = ldap;
  return sampleLdapProvider({
    id,
    slug: String(input.slug),
    name: String(input.name),
    issuer: String(ldap.url),
    flavor: String(ldap.flavor),
    position: previous?.position ?? state.providers.length,
    enabled: previous?.enabled ?? true,
    people: previous?.people ?? 0,
    lastSignInAt: previous?.lastSignInAt ?? null,
    createAccounts: Boolean(input.createAccounts),
    version: (previous?.version ?? 0) + 1,
    secret: typeof bindPassword === "string" ? bindPassword : (previous?.secret ?? ""),
    ldap: { ...(fields as unknown as LdapSettings), bindPasswordSet: true },
  });
}

function ldapConnectionOf(input: Input, stored: FakeProvider | undefined): string {
  const ldap = (input.ldap ?? {}) as Input;
  const password =
    typeof ldap.bindPassword === "string" ? ldap.bindPassword : (stored?.secret ?? "");
  return JSON.stringify([
    "ldap",
    ldap.url,
    ldap.encryption,
    ldap.certificate,
    ldap.caPem ?? null,
    ldap.bindDn,
    password,
  ]);
}

function storedLdapConnection(provider: FakeProvider): string {
  const ldap = provider.ldap;
  return JSON.stringify([
    "ldap",
    ldap?.url,
    ldap?.encryption,
    ldap?.certificate,
    ldap?.caPem ?? null,
    ldap?.bindDn,
    provider.secret,
  ]);
}

/** The provider's values a SAML check covers. */
function samlTrustOf(input: Input): string {
  const saml = (input.saml ?? {}) as Input;
  return JSON.stringify(["saml", saml.idpEntityId, saml.ssoUrl, saml.certificates]);
}

function fromSamlInput(state: FakeSsoState, input: Input, id: string, previous?: FakeProvider) {
  const saml = (input.saml ?? {}) as Input;
  const slug = String(input.slug);
  const certificates = (saml.certificates as string[]) ?? [];
  return sampleSamlProvider({
    id,
    slug,
    name: String(input.name),
    issuer: String(saml.idpEntityId),
    position: previous?.position ?? state.providers.length,
    enabled: previous?.enabled ?? true,
    people: previous?.people ?? 0,
    lastSignInAt: previous?.lastSignInAt ?? null,
    checkedAt: T0,
    createAccounts: Boolean(input.createAccounts),
    trustProviderMfa: Boolean(input.trustProviderMfa),
    redirectUri: `${state.samlBase ?? ""}/auth/saml/${slug}/acs`,
    version: (previous?.version ?? 0) + 1,
    saml: {
      metadataUrl: String(saml.metadataUrl ?? ""),
      idpEntityId: String(saml.idpEntityId),
      ssoUrl: String(saml.ssoUrl),
      certificates,
      certificateInfo: certificates.map((_, index) => ({
        fingerprint: `AB:CD:0${index}`,
        subject: "CN=idp.partnerportal.example",
        notAfter: Date.UTC(2027, 5, 1),
        expired: false,
      })),
      emailAttribute: String(saml.emailAttribute),
      nameAttribute: String(saml.nameAttribute),
      groupsAttribute: String(saml.groupsAttribute),
      trustEmail: Boolean(saml.trustEmail),
    },
  });
}

/** The SAML routes of the administration; undefined for any other path. */
function handleSamlRoute(
  state: FakeSsoState,
  rest: string,
  method: string,
  input: Input,
): Response | undefined {
  if (rest === "/saml/check" && method === "POST") {
    state.checksSent.push(input);
    const refused = state.checkRefusal;
    if (refused !== null) {
      state.checkRefusal = null;
      return refusal(422, "validation", refused.reason, refused.field, refused.params);
    }
    const saml = (input.saml ?? {}) as Input;
    // Metadata (a file or a URL) names the provider's values; without it the typed ones count.
    const fromMetadata = typeof saml.metadataXml === "string" || saml.metadataUrl !== "";
    const found = fromMetadata
      ? {
          metadataUrl: typeof saml.metadataXml === "string" ? "" : String(saml.metadataUrl),
          idpEntityId: "https://idp.partnerportal.example/saml",
          ssoUrl: "https://idp.partnerportal.example/saml/sso",
          certificates: [SAMPLE_CERT],
        }
      : {
          metadataUrl: "",
          idpEntityId: String(saml.idpEntityId),
          ssoUrl: String(saml.ssoUrl),
          certificates: (saml.certificates as string[]) ?? [],
        };
    const token = `saml-token-${tokens.size + 1}`;
    tokens.set(token, samlTrustOf({ saml: found }));
    return json(200, {
      ...samlAddresses(state.samlBase, String(input.slug)),
      checkToken: token,
      durationMs: 95,
      saml: found,
      certificates: found.certificates.map((_, index) => ({
        fingerprint: `AB:CD:0${index}`,
        subject: "CN=idp.partnerportal.example",
        notAfter: Date.UTC(2027, 5, 1),
        expired: false,
      })),
    });
  }
  if (rest === "/saml" && method === "POST") {
    state.samlSaved.push(input);
    if (tokens.get(String(input.checkToken ?? "")) !== samlTrustOf(input)) {
      return refusal(422, "validation", "saml.check_required", "idpEntityId");
    }
    const provider = fromSamlInput(state, input, `s${state.providers.length + 1}`);
    state.providers.push(provider);
    return json(201, detail(provider, state.samlBase));
  }
  if (rest === "/saml/test-sign-ins" && method === "POST") {
    state.samlTests.push(input);
    if (tokens.get(String(input.checkToken ?? "")) !== samlTrustOf(input)) {
      return refusal(422, "validation", "saml.check_required", "idpEntityId");
    }
    return json(201, {
      id: "saml-test-1",
      url: "https://idp.partnerportal.example/saml/sso?SAMLRequest=x",
    });
  }
  const change = /^\/saml\/([^/]+)$/.exec(rest);
  if (change !== null && method === "PUT") {
    state.samlSaved.push(input);
    const provider = state.providers.find((candidate) => candidate.id === change[1]);
    if (provider === undefined) {
      return error(404, "not_found");
    }
    if (input.version !== provider.version) {
      return json(409, {
        error: { code: "version_conflict", message: "stale" },
        current: detail(provider, state.samlBase),
      });
    }
    const trust = samlTrustOf(input);
    if (
      trust !== samlTrustOf({ saml: provider.saml }) &&
      tokens.get(String(input.checkToken ?? "")) !== trust
    ) {
      return refusal(422, "validation", "saml.check_required", "idpEntityId");
    }
    Object.assign(provider, fromSamlInput(state, input, provider.id, provider));
    return json(200, detail(provider, state.samlBase));
  }
  return undefined;
}

/** The LDAP routes of the administration; undefined for any other path. */
function handleLdapRoute(
  state: FakeSsoState,
  server: FakeServer,
  rest: string,
  method: string,
  input: Input,
): Response | undefined {
  if (rest === "/ldap/check" && method === "POST") {
    state.checksSent.push(input);
    const refused = state.checkRefusal;
    if (refused !== null) {
      state.checkRefusal = null;
      return refusal(422, "validation", refused.reason, refused.field, refused.params);
    }
    const stored = state.providers.find((provider) => provider.id === input.providerId);
    const token = `ldap-token-${tokens.size + 1}`;
    tokens.set(token, ldapConnectionOf(input, stored));
    const login = typeof input.testLogin === "string" ? input.testLogin : null;
    return json(200, {
      checkToken: token,
      durationMs: 180,
      tls: (input.ldap as Input | undefined)?.encryption === "none" ? null : "TLS 1.3",
      sample: { users: ["e.schroeder", "g.vogel"], groups: ["CN=Kalzit-Leser,OU=Gruppen"] },
      test:
        login === null
          ? null
          : {
              dn: `CN=${login},OU=Mitarbeitende`,
              login,
              email: "lea@example.com",
              name: "Lea Hoffmann",
              disabled: false,
              bound: typeof input.testPassword === "string",
              groups: ["CN=Kalzit-Leser,OU=Gruppen"],
              outcome: { refused: false, orgs: [] },
            },
    });
  }
  if (rest === "/ldap" && method === "POST") {
    state.ldapSaved.push(input);
    if (tokens.get(String(input.checkToken ?? "")) !== ldapConnectionOf(input, undefined)) {
      return refusal(422, "validation", "ldap.check_required", "url");
    }
    const provider = fromLdapInput(state, input, `l${state.providers.length + 1}`);
    state.providers.push(provider);
    return json(201, detail(provider, state.samlBase));
  }
  const change = /^\/ldap\/([^/]+)$/.exec(rest);
  if (change !== null && method === "PUT") {
    state.ldapSaved.push(input);
    const provider = state.providers.find((candidate) => candidate.id === change[1]);
    if (provider === undefined) {
      return error(404, "not_found");
    }
    if (input.version !== provider.version) {
      return json(409, {
        error: { code: "version_conflict", message: "stale" },
        current: detail(provider, state.samlBase),
      });
    }
    const connection = ldapConnectionOf(input, provider);
    if (
      connection !== storedLdapConnection(provider) &&
      tokens.get(String(input.checkToken ?? "")) !== connection
    ) {
      return refusal(422, "validation", "ldap.check_required", "url");
    }
    Object.assign(provider, fromLdapInput(state, input, provider.id, provider));
    return json(200, detail(provider, state.samlBase));
  }
  const sync = /^\/providers\/([^/]+)\/sync(?:\/runs\/([^/]+)(\/apply)?)?$/.exec(rest);
  if (sync === null) {
    return undefined;
  }
  const providerId = sync[1] ?? "";
  const syncState = state.syncs[providerId];
  if (syncState === undefined) {
    return error(404, "not_found");
  }
  const runId = sync[2];
  if (runId === undefined) {
    if (method === "GET") {
      const { pending: _pending, ...answer } = syncState;
      return json(200, answer);
    }
    if (method === "POST") {
      const run = sampleSyncRun({ id: `r${syncState.runs.length + 1}`, trigger: "manual" });
      syncState.runs.unshift(run);
      return json(200, run);
    }
    return undefined;
  }
  const run = syncState.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    return error(404, "not_found");
  }
  if (sync[3] === undefined && method === "GET") {
    return json(200, { ...run, pending: syncState.pending[runId] ?? [] });
  }
  if (sync[3] !== undefined && method === "POST") {
    const security = server.security;
    if (!security.totp && security.passkeys.length === 0) {
      return refusal(409, "conflict", "ldap.sync_needs_second_factor");
    }
    if (security.confirmedUntil === null || security.confirmedUntil <= Date.now()) {
      return error(403, "confirmation_required");
    }
    if (run.status !== "halted") {
      return refusal(409, "conflict", "ldap.sync_not_halted");
    }
    run.status = "applied";
    const applied = sampleSyncRun({
      id: `r${syncState.runs.length + 1}`,
      trigger: "apply",
      deactivated: (syncState.pending[runId] ?? []).length,
    });
    syncState.runs.unshift(applied);
    return json(200, applied);
  }
  return undefined;
}

/** The sign-in routes; undefined for any other path. */
export function handleSsoRoute(
  state: FakeSsoState,
  server: FakeServer,
  rawPath: string,
  method: string,
  input: Input,
  password: string,
): Response | undefined {
  const path = rawPath.split("?")[0] ?? "";
  if (path === "/api/auth/providers" && method === "GET") {
    return json(200, {
      providers: ordered(state)
        .filter((provider) => provider.enabled)
        .map(({ slug, name, kind }) => ({ slug, name, kind })),
      passwordForm: state.passwordForm,
      localSignIn: state.localPassword === "on",
    });
  }
  if ((path === "/api/auth/login" || path === "/api/auth/login/local") && method === "POST") {
    const user = server.state.user;
    const directory = state.providers.find((p) => p.kind === "ldap" && p.enabled);
    const typed = String(input.email ?? "");
    // A user name goes to the directory (docs/api/sso.md, "LDAP and Active Directory").
    if (path === "/api/auth/login" && directory !== undefined && !typed.includes("@")) {
      const answer = state.directoryAnswer;
      if (answer === "unreachable") {
        return refusal(503, "busy", "ldap.directory_unreachable");
      }
      if (answer !== "ok") {
        return refusal(403, "forbidden", "ldap.sign_in_refused", undefined, answer);
      }
      if (input.password !== password) {
        return error(401, "invalid_credentials");
      }
      server.state.signedIn = true;
      return json(200, user);
    }
    if (input.email !== user.email || input.password !== password) {
      return error(401, "invalid_credentials");
    }
    const breakGlass = path === "/api/auth/login/local" && state.breakGlass?.email === user.email;
    if (!breakGlass && (state.passwordOff.has(user.email) || state.localPassword === "off")) {
      return refusal(403, "forbidden", "sso.password_sign_in_off");
    }
    server.state.signedIn = true;
    return json(200, user);
  }
  if (!path.startsWith("/api/admin/sign-in")) {
    return undefined;
  }
  if (!server.state.signedIn) {
    return error(401, "unauthenticated");
  }
  if (!server.state.user.isServerAdmin) {
    return error(403, "forbidden");
  }
  const rest = path.slice("/api/admin/sign-in".length);
  const ldap = handleLdapRoute(state, server, rest, method, input);
  if (ldap !== undefined) {
    return ldap;
  }
  const saml = handleSamlRoute(state, rest, method, input);
  if (saml !== undefined) {
    return saml;
  }

  if (rest === "" && method === "GET") {
    return json(200, {
      providers: ordered(state).map(summary),
      accounts: state.accounts,
      viaProviders: state.viaProviders,
      redirectBase: state.redirectBase,
      samlBase: state.samlBase,
    });
  }
  if (rest === "/providers/check" && method === "POST") {
    state.checksSent.push(input);
    const refused = state.checkRefusal;
    if (refused !== null) {
      state.checkRefusal = null;
      return refusal(422, "validation", refused.reason, refused.field, refused.params);
    }
    const stored = state.providers.find((provider) => provider.id === input.providerId);
    const token = `token-${tokens.size + 1}`;
    tokens.set(token, connectionOf(input, stored));
    return json(200, { checkToken: token, keys: 2, durationMs: 210, clientAccepted: true });
  }
  if (rest === "/providers" && method === "POST") {
    const token = String(input.checkToken ?? "");
    if (tokens.get(token) !== connectionOf(input, undefined)) {
      return refusal(422, "validation", "sso.check_required", "issuer");
    }
    if (state.providers.some((provider) => provider.slug === input.slug)) {
      return refusal(409, "conflict", "sso.slug_taken", "slug");
    }
    const provider = fromInput(state, input, `p${state.providers.length + 1}`);
    state.providers.push(provider);
    return json(201, detail(provider, state.samlBase));
  }
  const one = /^\/providers\/([^/]+)(\/enabled)?$/.exec(rest);
  if (one !== null) {
    const provider = state.providers.find((candidate) => candidate.id === one[1]);
    if (provider === undefined) {
      return error(404, "not_found");
    }
    if (one[2] !== undefined && method === "PATCH") {
      provider.enabled = Boolean(input.enabled);
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      return json(200, detail(provider, state.samlBase));
    }
    if (method === "PUT") {
      if (input.version !== provider.version) {
        return json(409, {
          error: { code: "version_conflict", message: "stale" },
          current: detail(provider, state.samlBase),
        });
      }
      const changed =
        connectionOf(input, provider) !==
        JSON.stringify([provider.oidc.issuer, provider.oidc.clientId, provider.secret]);
      if (changed && tokens.get(String(input.checkToken ?? "")) !== connectionOf(input, provider)) {
        return refusal(422, "validation", "sso.check_required", "issuer");
      }
      // Another issuer removes the links of the people, after a confirmation (docs/api/sso.md).
      const issuer = (input.oidc as Input | undefined)?.issuer;
      const issuerChanged = issuer !== provider.oidc.issuer;
      if (issuerChanged && provider.people > 0 && input.confirmIssuerChange !== true) {
        return refusal(409, "conflict", "sso.issuer_change_confirm", "issuer", {
          people: provider.people,
        });
      }
      const updated = fromInput(state, input, provider.id, provider);
      Object.assign(provider, updated);
      if (issuerChanged) {
        provider.people = 0;
      }
      return json(200, detail(provider, state.samlBase));
    }
    if (method === "DELETE") {
      if (provider.people > 0) {
        return refusal(409, "conflict", "sso.provider_in_use", undefined, {
          people: provider.people,
        });
      }
      state.providers = state.providers.filter((candidate) => candidate !== provider);
      state.mappings = state.mappings.filter((mapping) => mapping.providerId !== provider.id);
      return new Response(null, { status: 204 });
    }
  }
  if (rest === "/order" && method === "PUT") {
    const ids = input.ids as string[];
    if (ids.length !== state.providers.length) {
      return error(422, "validation", "ids");
    }
    for (const provider of state.providers) {
      provider.position = ids.indexOf(provider.id);
    }
    return new Response(null, { status: 204 });
  }
  if (rest === "/test-sign-ins" && method === "POST") {
    return json(201, { id: "test-1", url: "https://sso.example/authorize?state=test" });
  }
  if (rest.startsWith("/test-sign-ins/") && method === "GET") {
    return json(200, state.testAnswer);
  }
  if (rest === "/mappings" && method === "GET") {
    return json(200, {
      mappings: state.mappings,
      unmapped: state.unmapped,
      orgs: [{ id: "o1", name: "Analytical Engines", teams: [{ id: "t1", name: "Plattform" }] }],
    });
  }
  if (rest === "/mappings" && method === "POST") {
    const provider = state.providers.find((candidate) => candidate.id === input.providerId);
    const mapping: Mapping = {
      id: `m${state.mappings.length + 100}`,
      providerId: String(input.providerId),
      providerName: provider?.name ?? "",
      group: String(input.group),
      orgId: String(input.orgId),
      orgName: "Analytical Engines",
      teamId: typeof input.teamId === "string" ? input.teamId : null,
      teamName: null,
      role: String(input.role),
      idpDecides: Boolean(input.idpDecides),
      people: 0,
    };
    state.mappings.push(mapping);
    return json(201, mapping);
  }
  const mappingMatch = /^\/mappings\/([^/]+)$/.exec(rest);
  if (mappingMatch !== null && mappingMatch[1] !== "preview") {
    const mapping = state.mappings.find((candidate) => candidate.id === mappingMatch[1]);
    if (mapping === undefined) {
      return error(404, "not_found");
    }
    if (method === "PATCH") {
      Object.assign(mapping, input);
      return json(200, mapping);
    }
    if (method === "DELETE") {
      state.mappings = state.mappings.filter((candidate) => candidate !== mapping);
      return new Response(null, { status: 204 });
    }
  }
  if (rest === "/mappings/preview" && method === "POST") {
    return json(200, {
      groups: [{ providerId: "p1", providerName: "Müller SSO", groups: ["controlling"] }],
      outcome: {
        refused: false,
        orgs: [
          {
            orgId: "o1",
            orgName: "Analytical Engines",
            role: "editor",
            group: "controlling",
            teams: [],
            idpDecides: false,
            default: false,
          },
        ],
      },
    });
  }
  if (rest === "/unmapped" && method === "PUT") {
    state.unmapped = input as unknown as Unmapped;
    return new Response(null, { status: 204 });
  }
  if (rest === "/local" && method === "GET") {
    return json(200, {
      localPassword: state.localPassword,
      passwordForm: state.passwordForm,
      breakGlass: state.breakGlass,
      readOnly: state.readOnly,
      checks: state.checks,
    });
  }
  if (rest === "/local" && method === "PUT") {
    if (state.readOnly) {
      return refusal(409, "conflict", "sso.settings_read_only");
    }
    state.localPassword = input.localPassword as "on" | "off";
    state.passwordForm = input.passwordForm as PasswordFormMode;
    return new Response(null, { status: 204 });
  }
  return error(404, "not_found");
}
