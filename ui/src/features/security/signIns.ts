/**
 * Recent sign-ins (docs/api/access.md, "Recent sign-ins"): everyone sees their own on the account
 * page, server admins those of anyone on the user page. Every answer is checked, so a mismatch
 * fails as `invalid_response` instead of rendering half a list.
 */
import { expectShape, isRecord, request } from "../../api/client";
import type { ListPage } from "../admin/api";

export type SignInMethod = "password" | "break_glass" | "oidc" | "saml" | "ldap" | "provider";

export interface SignIn {
  id: string;
  at: number;
  result: "success" | "refused";
  /** credentials, disabled, password_off, second_factor, or the reason of a provider (sso.unmapped). */
  reason: string | null;
  method: SignInMethod | null;
  provider: string | null;
  providerName: string | null;
  secondFactor: "passkey" | "totp" | "recovery" | "provider" | null;
  address: string | null;
  userAgent: string | null;
  current: boolean;
}

const METHODS = ["password", "break_glass", "oidc", "saml", "ldap", "provider"];
const FACTORS = ["passkey", "totp", "recovery", "provider"];

const nullableString = (value: unknown) => value === null || typeof value === "string";
const nullableOf = (values: string[]) => (value: unknown) =>
  value === null || (typeof value === "string" && values.includes(value));

function isSignIn(value: unknown): value is SignIn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "number" &&
    (value.result === "success" || value.result === "refused") &&
    nullableString(value.reason) &&
    nullableOf(METHODS)(value.method) &&
    nullableString(value.provider) &&
    nullableString(value.providerName) &&
    nullableOf(FACTORS)(value.secondFactor) &&
    nullableString(value.address) &&
    nullableString(value.userAgent) &&
    typeof value.current === "boolean"
  );
}

function isPage(value: unknown): value is ListPage<SignIn> {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isSignIn) &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}

function path(base: string, limit: number, cursor: string | undefined): string {
  const search = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) {
    search.set("cursor", cursor);
  }
  return `${base}?${search.toString()}`;
}

/** The sign-ins of the signed-in person, newest first. */
export async function fetchMySignIns(limit: number, cursor?: string): Promise<ListPage<SignIn>> {
  return expectShape(
    await request("GET", path("/api/me/sign-ins", limit, cursor)),
    isPage,
    "sign-in list",
  );
}

/** The sign-ins of a person, for server admins. */
export async function fetchUserSignIns(
  userId: string,
  limit: number,
  cursor?: string,
): Promise<ListPage<SignIn>> {
  const base = `/api/admin/users/${encodeURIComponent(userId)}/sign-ins`;
  return expectShape(await request("GET", path(base, limit, cursor)), isPage, "sign-in list");
}

export const signInKeys = {
  mine: ["me", "signIns"] as const,
  user: (userId: string) => ["admin", "server", "users", userId, "signIns"] as const,
};

/** The browser and system a user agent names, as far as it tells; device names stay English. */
export interface Device {
  browser: string | null;
  /** A system name, or "phone" / "tablet" for mobile devices. */
  system: string | null;
}

export function deviceOf(userAgent: string): Device {
  const ua = userAgent;
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\/|Chromium\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const system = /iPad|Tablet/.test(ua)
    ? "tablet"
    : /iPhone|Android.*Mobile|Mobile.*Android|Windows Phone/.test(ua)
      ? "phone"
      : /Android/.test(ua)
        ? "tablet"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux|X11/.test(ua)
                ? "Linux"
                : null;
  return { browser, system };
}
