/**
 * The pages behind the links Kalzit sends (docs/api/mail.md): accepting an invitation and setting
 * a new password. The token travels in the link's fragment, which browsers never send to a
 * server; the page passes it on in a request body.
 */
import { isMe, type Me } from "../api/auth";
import { expectShape, isRecord, request } from "../api/client";

export interface InvitationInfo {
  orgName: string;
  inviterName: string | null;
  email: string;
  /** A built-in role name or a custom role id; `roleName` names a custom role. */
  role: string;
  roleName: string;
  teamName: string | null;
  expiresAt: number;
  state: "valid" | "expired" | "accepted";
  accountExists: boolean;
  signedInAs: { name: string; email: string } | null;
  /** A password of Kalzit's own may be set. */
  password: boolean;
  /** Single sign-on providers the page offers; none until single sign-on exists. */
  sso: { id: string; name: string }[];
}

const isText = (value: unknown) => typeof value === "string";
const isOptionalText = (value: unknown) => value === null || typeof value === "string";

function isInvitationInfo(value: unknown): value is InvitationInfo {
  return (
    isRecord(value) &&
    isText(value.orgName) &&
    isOptionalText(value.inviterName) &&
    isText(value.email) &&
    isText(value.role) &&
    isText(value.roleName) &&
    isOptionalText(value.teamName) &&
    typeof value.expiresAt === "number" &&
    ["valid", "expired", "accepted"].includes(String(value.state)) &&
    typeof value.accountExists === "boolean" &&
    (value.signedInAs === null ||
      (isRecord(value.signedInAs) &&
        isText(value.signedInAs.name) &&
        isText(value.signedInAs.email))) &&
    typeof value.password === "boolean" &&
    Array.isArray(value.sso)
  );
}

export async function inspectInvitation(token: string): Promise<InvitationInfo> {
  return expectShape(
    await request("POST", "/api/auth/invitation", { token }),
    isInvitationInfo,
    "invitation",
  );
}

/**
 * Joins: with name and password for a new account, with the token alone when signed in. A new
 * account that must set up a second factor first gets the sign-in's second step instead of the
 * user (`secondFactor`, checked by features/security), like at any sign-in.
 */
export async function acceptInvitation(
  token: string,
  account?: { name: string; password: string },
): Promise<Me | { secondFactor: unknown }> {
  const body = await request("POST", "/api/auth/invitation/accept", { token, ...account });
  if (isRecord(body) && "secondFactor" in body) {
    return { secondFactor: body.secondFactor };
  }
  return expectShape(body, isMe, "invitation");
}

export async function fetchResetAvailability(): Promise<boolean> {
  const answer = await request("GET", "/api/auth/password-reset");
  return expectShape(
    answer,
    (value): value is { available: boolean } =>
      isRecord(value) && typeof value.available === "boolean",
    "password reset",
  ).available;
}

/** Asks for a link; the answer is the same whether or not an account has the address. */
export async function requestPasswordLink(email: string): Promise<void> {
  await request("POST", "/api/auth/password-reset", { email });
}

export async function inspectPasswordLink(
  token: string,
): Promise<{ email: string; expiresAt: number }> {
  return expectShape(
    await request("POST", "/api/auth/password-reset/inspect", { token }),
    (value): value is { email: string; expiresAt: number } =>
      isRecord(value) && isText(value.email) && typeof value.expiresAt === "number",
    "password link",
  );
}

/** Confirms the address of the link's account (docs/api/mail.md, "Email confirmation"). */
export async function confirmEmail(token: string): Promise<void> {
  await request("POST", "/api/me/email-confirmation/confirm", { token });
}

/** Sets the new password; every session of the account ends with it. */
export async function completePasswordReset(token: string, password: string): Promise<void> {
  await request("POST", "/api/auth/password-reset/complete", { token, password });
}

export type LinkKind = "invite" | "reset" | "confirm";

/**
 * Where a link's token waits in this tab once it left the address bar: while its person signs
 * in first (invitations), or across a reload.
 */
const KEPT: Record<LinkKind, string> = {
  invite: "kalzit.link.invite",
  reset: "kalzit.link.reset",
  confirm: "kalzit.link.confirm",
};

/**
 * The token of the page's link: the fragment (`hash`, as the router reads it), else the one kept
 * in this tab. The page then replaces its address without the fragment, so the token stays out of
 * the history.
 */
export function readToken(kind: LinkKind, hash: string): string {
  const fragment = hash.replace(/^#/, "").trim();
  if (fragment !== "") {
    keep(kind, fragment);
    return fragment;
  }
  try {
    return window.sessionStorage.getItem(KEPT[kind]) ?? "";
  } catch {
    return "";
  }
}

function keep(kind: LinkKind, token: string): void {
  try {
    window.sessionStorage.setItem(KEPT[kind], token);
  } catch {
    // Without storage, signing in first needs the link once more.
  }
}

/** Forgets the kept token once the link did its work (or no longer works). */
export function forgetToken(kind: LinkKind): void {
  try {
    window.sessionStorage.removeItem(KEPT[kind]);
  } catch {
    // Nothing kept.
  }
}
