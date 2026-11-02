import type { Me } from "../../../api/auth";
import type { PasskeyInfo, RequiredBy } from "../api";
import type { SignIn } from "../signIns";

/**
 * The second factor of the fake server (docs/api/access.md, "Second factor"): an authenticator
 * app whose current code is `code`, recovery codes, the lockout after five wrong codes, a forced
 * setup, fresh confirmations and admin resets. Passkeys are listed but not signed (jsdom has no
 * WebAuthn); the real ceremony runs in the server tests against a software authenticator.
 */
export interface FakeSecurity {
  totp: boolean;
  passkeys: PasskeyInfo[];
  /** The code the app shows now. */
  code: string;
  recoveryCodes: string[];
  required: RequiredBy | null;
  allowed: { passkey: boolean; totp: boolean };
  pending: boolean;
  /** A provider linked the account by email: its password comes first (`linkPassword`). */
  linkPassword: boolean;
  /** The account's own password, for `linkPassword`. */
  accountPassword: string;
  failures: number;
  lockedUntil: number | null;
  confirmedUntil: number | null;
  /** Resets an admin made, by path, with their body. */
  resets: { path: string; body: unknown }[];
  /** The recent sign-ins every list answers, and the paths that asked for them. */
  signIns: SignIn[];
  signInRequests: string[];
}

export function fakeSecurityState(): FakeSecurity {
  return {
    totp: false,
    passkeys: [],
    code: "246810",
    recoveryCodes: [],
    required: null,
    allowed: { passkey: true, totp: true },
    pending: false,
    linkPassword: false,
    accountPassword: "",
    failures: 0,
    lockedUntil: null,
    confirmedUntil: null,
    resets: [],
    signIns: [],
    signInRequests: [],
  };
}

const CODES = [
  "k7q2-m9xd-p4tz-8wna",
  "c3hv-r2ke-x9bm-5fgu",
  "w2nd-q7ls-h6yr-3jcp",
  "e8va-t4zm-u5kf-9xqb",
  "r3gp-6dwe-n7cs-2hyt",
  "a2b3-c4d5-e6f7-g8h9",
  "j2k3-m4n5-p6q7-r8s9",
  "t2u3-v4w5-x6y7-z802",
  "b3c4-d5e6-f7g8-h9j2",
  "k3m4-n5p6-q7r8-s9t2",
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fail(status: number, code: string, reason?: string, params?: Record<string, string>) {
  return json(status, { error: { code, message: `server message for ${code}`, reason, params } });
}

const SETUP = {
  secret: "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP",
  uri: "otpauth://totp/Kalzit:ada@example.com?secret=JBSWY3DPEHPK3PXP",
  qr: { size: 21, path: "M0 0h7v1h-7z" },
  issuer: "Kalzit (localhost)",
  account: "ada@example.com",
};

/**
 * Answers the second factor's routes, or undefined for others. `signIn` opens the session of the
 * fake server; `signedIn` says whether there is one.
 */
export function handleSecurityRoute(
  s: FakeSecurity,
  path: string,
  method: string,
  input: Record<string, unknown>,
  session: { user: Me; signedIn: boolean; signIn: () => void },
): Response | undefined {
  const now = Date.now();
  const methods = () => [
    ...(s.passkeys.length > 0 ? ["passkey"] : []),
    ...(s.totp ? ["totp"] : []),
    ...(s.recoveryCodes.length > 0 ? ["recovery"] : []),
  ];
  const prompt = () => ({
    email: session.user.email,
    setup: !s.totp && s.passkeys.length === 0,
    methods: methods(),
    lastUsed: null,
    allowed: s.allowed,
    requiredBy: s.required,
    lockedUntil: s.lockedUntil !== null && s.lockedUntil > now ? s.lockedUntil : null,
    expiresAt: now + 300_000,
    linkPassword: s.linkPassword,
  });
  /** A code attempt, counted against the lockout. */
  const check = (ok: boolean): Response | null => {
    if (s.lockedUntil !== null && s.lockedUntil > now) {
      return fail(429, "rate_limited", "second_factor.locked", { until: String(s.lockedUntil) });
    }
    if (ok) {
      s.failures = 0;
      return null;
    }
    s.failures += 1;
    if (s.failures >= 5) {
      s.failures = 0;
      s.lockedUntil = now + 15 * 60_000;
      return fail(429, "rate_limited", "second_factor.locked", { until: String(s.lockedUntil) });
    }
    return fail(422, "invalid_code");
  };
  const proofOk = (): Response | null => {
    if (input.method === "totp") {
      return check(s.totp && input.code === s.code);
    }
    if (input.method === "recovery") {
      const code = String(input.code ?? "").toLowerCase();
      const index = s.recoveryCodes.indexOf(code);
      const answer = check(index >= 0);
      if (answer === null) {
        s.recoveryCodes.splice(index, 1);
      }
      return answer;
    }
    return fail(422, "invalid_code", "second_factor.passkey_refused");
  };
  const firstCodes = () => {
    s.recoveryCodes = [...CODES];
    return [...CODES];
  };

  if (path === "/api/auth/second-factor" && method === "GET") {
    return s.pending
      ? json(200, prompt())
      : fail(401, "unauthenticated", "second_factor.pending_expired");
  }
  if (path.startsWith("/api/auth/second-factor")) {
    if (!s.pending) {
      return fail(401, "unauthenticated", "second_factor.pending_expired");
    }
    if (path === "/api/auth/second-factor" && method === "POST") {
      const refused = proofOk();
      if (refused !== null) {
        return refused;
      }
      s.pending = false;
      session.signIn();
      return json(200, {
        me: session.user,
        ...(input.method === "recovery" ? { recoveryCodesRemaining: s.recoveryCodes.length } : {}),
      });
    }
    if (path === "/api/auth/second-factor/password" && method === "POST") {
      if (input.password !== s.accountPassword) {
        return json(401, {
          error: { code: "invalid_credentials", message: "wrong", field: "password" },
        });
      }
      s.linkPassword = false;
      if (prompt().setup && s.required !== null) {
        return json(200, { secondFactor: prompt() });
      }
      s.pending = false;
      session.signIn();
      return json(200, { me: session.user });
    }
    if (path === "/api/auth/second-factor/setup/totp") {
      return json(200, SETUP);
    }
    if (path === "/api/auth/second-factor/setup") {
      if (input.code !== s.code) {
        return fail(422, "invalid_code");
      }
      s.totp = true;
      s.pending = false;
      session.signIn();
      return json(200, { me: session.user, recoveryCodes: firstCodes() });
    }
    return undefined;
  }

  const signInList =
    path.startsWith("/api/me/sign-ins") || /^\/api\/admin\/users\/[^/]+\/sign-ins/.test(path);
  if (signInList && method === "GET") {
    if (!session.signedIn) {
      return fail(401, "unauthenticated");
    }
    s.signInRequests.push(path);
    return json(200, { items: s.signIns, nextCursor: null });
  }

  if (!path.startsWith("/api/me/security")) {
    return undefined;
  }
  if (!session.signedIn) {
    return fail(401, "unauthenticated");
  }
  const has = s.totp || s.passkeys.length > 0;
  const fresh = s.confirmedUntil !== null && s.confirmedUntil > now;
  if (path === "/api/me/security" && method === "GET") {
    return json(200, {
      required: s.required !== null,
      requiredBy: s.required,
      allowed: s.allowed,
      totp: s.totp ? { createdAt: 1_790_000_000_000, lastUsedAt: null } : null,
      passkeys: s.passkeys,
      recoveryCodes:
        has && s.recoveryCodes.length > 0
          ? { remaining: s.recoveryCodes.length, total: 10, createdAt: 1_790_000_000_000 }
          : null,
      confirmedUntil: fresh ? s.confirmedUntil : null,
      lockedUntil: s.lockedUntil !== null && s.lockedUntil > now ? s.lockedUntil : null,
      hasPassword: true,
    });
  }
  if (path === "/api/me/security/confirm" && method === "POST") {
    const refused = proofOk();
    if (refused !== null) {
      return refused;
    }
    s.confirmedUntil = now + 300_000;
    return json(200, { confirmedUntil: s.confirmedUntil });
  }
  if (path === "/api/me/security/totp/setup" && method === "POST") {
    return has && !fresh ? fail(403, "confirmation_required") : json(200, SETUP);
  }
  if (path === "/api/me/security/totp" && method === "POST") {
    if (input.code !== s.code) {
      return fail(422, "invalid_code", undefined);
    }
    const first = !has;
    s.totp = true;
    return json(200, { recoveryCodes: first ? firstCodes() : null });
  }
  if (path === "/api/me/security/totp" && method === "DELETE") {
    if (!fresh) {
      return fail(403, "confirmation_required");
    }
    if (s.required !== null && s.passkeys.length === 0) {
      return fail(409, "conflict", "second_factor.last_method");
    }
    s.totp = false;
    return new Response(null, { status: 204 });
  }
  if (path === "/api/me/security/recovery-codes" && method === "POST") {
    if (!fresh) {
      return fail(403, "confirmation_required");
    }
    return json(200, { recoveryCodes: firstCodes() });
  }
  return undefined;
}

/** An admin's reset of another person's second factor; answers undefined for other routes. */
export function handleResetRoute(
  s: FakeSecurity,
  path: string,
  method: string,
  body: unknown,
): Response | undefined {
  if (method !== "POST" || !path.endsWith("/second-factor/reset")) {
    return undefined;
  }
  if (s.confirmedUntil === null || s.confirmedUntil <= Date.now()) {
    return fail(403, "confirmation_required");
  }
  s.resets.push({ path, body });
  return json(200, { removed: { totp: true, passkeys: 0, recoveryCodes: 10 }, sessionsEnded: 1 });
}
