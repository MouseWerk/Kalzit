import type { FakeArea, FakeServer } from "../../../../test/fakeServer";
import { error, json } from "../../../../test/fakeServer";
import type {
  LocalChecks,
  Mapping,
  OidcSettings,
  PasswordFormMode,
  ProviderSummary,
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
  const { version: _version, oidc: _oidc, secret: _secret, ...rest } = provider;
  return rest;
}

function detail(provider: FakeProvider) {
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

  if (rest === "" && method === "GET") {
    return json(200, {
      providers: ordered(state).map(summary),
      accounts: state.accounts,
      viaProviders: state.viaProviders,
      redirectBase: state.redirectBase,
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
    return json(201, detail(provider));
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
      return json(200, detail(provider));
    }
    if (method === "PUT") {
      if (input.version !== provider.version) {
        return json(409, {
          error: { code: "version_conflict", message: "stale" },
          current: detail(provider),
        });
      }
      const changed =
        connectionOf(input, provider) !==
        JSON.stringify([provider.oidc.issuer, provider.oidc.clientId, provider.secret]);
      if (changed && tokens.get(String(input.checkToken ?? "")) !== connectionOf(input, provider)) {
        return refusal(422, "validation", "sso.check_required", "issuer");
      }
      const updated = fromInput(state, input, provider.id, provider);
      Object.assign(provider, updated);
      return json(200, detail(provider));
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
