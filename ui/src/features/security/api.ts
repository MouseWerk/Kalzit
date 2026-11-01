/**
 * Calls of the second factor (docs/api/access.md, "Second factor"): the second step of a
 * sign-in, the account's own methods, and an admin's reset. Every answer is checked, so a
 * mismatch fails as `invalid_response` instead of rendering half a page.
 */
import { isMe, type Me } from "../../api/auth";
import { ApiError, expectShape, isApiError, isRecord, request } from "../../api/client";

export type FactorMethod = "passkey" | "totp" | "recovery";
export type SetupMethod = "passkey" | "totp";

export type RequiredBy = { kind: "server" } | { kind: "org"; id: string; name: string };

export interface Allowed {
  passkey: boolean;
  totp: boolean;
}

/** What the second step of a sign-in needs (`POST /auth/login` as `secondFactor`). */
export interface Prompt {
  email: string;
  setup: boolean;
  methods: FactorMethod[];
  lastUsed: SetupMethod | null;
  allowed: Allowed;
  requiredBy: RequiredBy | null;
  lockedUntil: number | null;
  expiresAt: number;
  /**
   * The account's own password comes first: a provider linked its identity to the account by the
   * email address, and the account has no second factor to prove it with.
   */
  linkPassword?: boolean | undefined;
}

export interface QrCode {
  size: number;
  path: string;
}

export interface TotpSetup {
  /** The key in Base32, in groups of four. */
  secret: string;
  uri: string;
  qr: QrCode | null;
  issuer: string;
  account: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SecurityStatus {
  required: boolean;
  requiredBy: RequiredBy | null;
  allowed: Allowed;
  totp: { createdAt: number; lastUsedAt: number | null } | null;
  passkeys: PasskeyInfo[];
  recoveryCodes: { remaining: number; total: number; createdAt: number } | null;
  confirmedUntil: number | null;
  lockedUntil: number | null;
  hasPassword: boolean;
}

/** A person's second factor as lists of people show it. */
export interface SecondFactorSummary {
  methods: SetupMethod[];
  lockedUntil: number | null;
  required: boolean;
}

export type Proof =
  | { method: "totp"; code: string }
  | { method: "recovery"; code: string }
  | { method: "passkey"; credential: unknown };

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNullableNumber = (value: unknown) => value === null || isNumber(value);

function isRequiredBy(value: unknown): value is RequiredBy | null {
  return (
    value === null ||
    (isRecord(value) &&
      (value.kind === "server" ||
        (value.kind === "org" && typeof value.id === "string" && typeof value.name === "string")))
  );
}

function isAllowed(value: unknown): value is Allowed {
  return isRecord(value) && typeof value.passkey === "boolean" && typeof value.totp === "boolean";
}

const METHODS: readonly string[] = ["passkey", "totp", "recovery"];

export function isPrompt(value: unknown): value is Prompt {
  return (
    isRecord(value) &&
    typeof value.email === "string" &&
    typeof value.setup === "boolean" &&
    Array.isArray(value.methods) &&
    value.methods.every((m) => typeof m === "string" && METHODS.includes(m)) &&
    (value.lastUsed === null || value.lastUsed === "passkey" || value.lastUsed === "totp") &&
    isAllowed(value.allowed) &&
    isRequiredBy(value.requiredBy) &&
    isNullableNumber(value.lockedUntil) &&
    isNumber(value.expiresAt) &&
    (value.linkPassword === undefined || typeof value.linkPassword === "boolean")
  );
}

function isTotpSetup(value: unknown): value is TotpSetup {
  return (
    isRecord(value) &&
    typeof value.secret === "string" &&
    typeof value.uri === "string" &&
    typeof value.issuer === "string" &&
    typeof value.account === "string" &&
    (value.qr === null ||
      (isRecord(value.qr) && isNumber(value.qr.size) && typeof value.qr.path === "string"))
  );
}

function isPasskeyInfo(value: unknown): value is PasskeyInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNumber(value.createdAt) &&
    isNullableNumber(value.lastUsedAt)
  );
}

function isStatus(value: unknown): value is SecurityStatus {
  return (
    isRecord(value) &&
    typeof value.required === "boolean" &&
    isRequiredBy(value.requiredBy) &&
    isAllowed(value.allowed) &&
    (value.totp === null || (isRecord(value.totp) && isNumber(value.totp.createdAt))) &&
    Array.isArray(value.passkeys) &&
    value.passkeys.every(isPasskeyInfo) &&
    (value.recoveryCodes === null ||
      (isRecord(value.recoveryCodes) && isNumber(value.recoveryCodes.remaining))) &&
    isNullableNumber(value.confirmedUntil) &&
    isNullableNumber(value.lockedUntil) &&
    typeof value.hasPassword === "boolean"
  );
}

export function isSummary(value: unknown): value is SecondFactorSummary {
  return (
    isRecord(value) &&
    Array.isArray(value.methods) &&
    value.methods.every((m) => m === "passkey" || m === "totp") &&
    isNullableNumber(value.lockedUntil) &&
    typeof value.required === "boolean"
  );
}

const isCodes = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((code) => typeof code === "string");

/** The stable reason of an API error (`error.reason`), when the server sent one. */
export function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !isRecord(error.body) || !isRecord(error.body.error)) {
    return undefined;
  }
  const reason = error.body.error.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** The end of a lockout after too many wrong codes, from the error that reported it. */
export function lockedUntilOf(error: unknown): number | null {
  if (!isApiError(error, "rate_limited") || reasonOf(error) !== "second_factor.locked") {
    return null;
  }
  const body = error.body;
  const params = isRecord(body) && isRecord(body.error) ? body.error.params : undefined;
  const until = isRecord(params) ? Number(params.until) : Number.NaN;
  return Number.isFinite(until) ? until : Date.now() + (error.retryAfterMs ?? 15 * 60_000);
}

// The second step of a sign-in

export interface SignedIn {
  me: Me;
  recoveryCodesRemaining?: number | undefined;
  recoveryCodes?: string[] | undefined;
}

function isSignedIn(value: unknown): value is SignedIn {
  return (
    isRecord(value) &&
    isMe(value.me) &&
    (value.recoveryCodesRemaining === undefined || isNumber(value.recoveryCodesRemaining)) &&
    (value.recoveryCodes === undefined || isCodes(value.recoveryCodes))
  );
}

export async function fetchPrompt(): Promise<Prompt> {
  return expectShape(await request("GET", "/api/auth/second-factor"), isPrompt, "second step");
}

/**
 * The account's password in the second step (`Prompt.linkPassword`): signed in, or the setup of a
 * second factor the account must have comes next.
 */
export async function signInWithPassword(
  password: string,
): Promise<SignedIn | { secondFactor: Prompt }> {
  const body = await request("POST", "/api/auth/second-factor/password", { password });
  if (isRecord(body) && "secondFactor" in body) {
    return { secondFactor: expectShape(body.secondFactor, isPrompt, "second step") };
  }
  return expectShape(body, isSignedIn, "second step");
}

export async function signInWith(proof: Proof): Promise<SignedIn> {
  return expectShape(
    await request("POST", "/api/auth/second-factor", proof),
    isSignedIn,
    "second step",
  );
}

export async function signInPasskeyOptions(): Promise<unknown> {
  return request("POST", "/api/auth/second-factor/passkey", {});
}

export async function startSetupTotp(): Promise<TotpSetup> {
  return expectShape(
    await request("POST", "/api/auth/second-factor/setup/totp", {}),
    isTotpSetup,
    "app setup",
  );
}

export async function startSetupPasskey(): Promise<unknown> {
  return request("POST", "/api/auth/second-factor/setup/passkey", {});
}

export type SetupInput =
  | { method: "totp"; code: string }
  | { method: "passkey"; name?: string; credential: unknown };

export async function finishSetup(input: SetupInput): Promise<SignedIn> {
  return expectShape(
    await request("POST", "/api/auth/second-factor/setup", input),
    isSignedIn,
    "setup",
  );
}

// The account's own methods

export async function fetchSecurity(): Promise<SecurityStatus> {
  return expectShape(await request("GET", "/api/me/security"), isStatus, "security");
}

export async function confirmFactor(proof: Proof): Promise<number> {
  const body = await request("POST", "/api/me/security/confirm", proof);
  const until = isRecord(body) ? body.confirmedUntil : undefined;
  return expectShape(until, isNumber, "confirmation");
}

export async function confirmPasskeyOptions(): Promise<unknown> {
  return request("POST", "/api/me/security/confirm/passkey", {});
}

export async function startTotp(): Promise<TotpSetup> {
  return expectShape(
    await request("POST", "/api/me/security/totp/setup", {}),
    isTotpSetup,
    "app setup",
  );
}

function codesOf(body: unknown): string[] | null {
  const codes = isRecord(body) ? body.recoveryCodes : undefined;
  return isCodes(codes) ? codes : null;
}

/** Saves the app; answers the first recovery codes when it was the account's first method. */
export async function saveTotp(code: string): Promise<string[] | null> {
  return codesOf(await request("POST", "/api/me/security/totp", { code }));
}

export async function removeTotp(): Promise<void> {
  await request("DELETE", "/api/me/security/totp");
}

export async function startPasskey(): Promise<unknown> {
  return request("POST", "/api/me/security/passkeys/setup", {});
}

export async function savePasskey(name: string, credential: unknown): Promise<string[] | null> {
  return codesOf(await request("POST", "/api/me/security/passkeys", { name, credential }));
}

export async function renamePasskey(id: string, name: string): Promise<PasskeyInfo> {
  return expectShape(
    await request("PATCH", `/api/me/security/passkeys/${encodeURIComponent(id)}`, { name }),
    isPasskeyInfo,
    "passkey",
  );
}

export async function removePasskey(id: string): Promise<void> {
  await request("DELETE", `/api/me/security/passkeys/${encodeURIComponent(id)}`);
}

export async function newRecoveryCodes(): Promise<string[]> {
  return expectShape(
    codesOf(await request("POST", "/api/me/security/recovery-codes", {})),
    isCodes,
    "recovery codes",
  );
}

// An admin's reset

export async function resetMemberSecondFactor(
  orgId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const path = `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/second-factor/reset`;
  await request("POST", path, reason === "" ? {} : { reason });
}

export async function resetUserSecondFactor(userId: string, reason: string): Promise<void> {
  const path = `/api/admin/users/${encodeURIComponent(userId)}/second-factor/reset`;
  await request("POST", path, reason === "" ? {} : { reason });
}

export type Requirement = "off" | "admins" | "everyone";

export interface OrgPolicy {
  id: string;
  name: string;
  policy: string;
  effective: Requirement;
  missing: number;
}

export interface TwoFactorOverview {
  server: Requirement;
  orgs: OrgPolicy[];
}

const REQUIREMENTS: readonly string[] = ["off", "admins", "everyone"];

function isOverview(value: unknown): value is TwoFactorOverview {
  return (
    isRecord(value) &&
    typeof value.server === "string" &&
    REQUIREMENTS.includes(value.server) &&
    Array.isArray(value.orgs) &&
    value.orgs.every(
      (org) =>
        isRecord(org) &&
        typeof org.id === "string" &&
        typeof org.name === "string" &&
        typeof org.policy === "string" &&
        typeof org.effective === "string" &&
        REQUIREMENTS.includes(org.effective) &&
        isNumber(org.missing),
    )
  );
}

export async function fetchOverview(): Promise<TwoFactorOverview> {
  return expectShape(
    await request("GET", "/api/admin/security/two-factor"),
    isOverview,
    "second factor overview",
  );
}

export const securityKeys = {
  status: ["me", "security"] as const,
  overview: ["admin", "security", "twoFactor"] as const,
};
