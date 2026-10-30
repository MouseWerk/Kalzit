/**
 * Invitations of an organization and the members' password links (docs/api/mail.md,
 * "Invitations" and "Password reset"). Every response is checked like the rest of the
 * administration's calls.
 */
import { expectShape, isRecord, request } from "../../api/client";
import type { ListPage } from "./api";

export type InvitationDelivery = "none" | "pending" | "sent" | "failed";

export interface Invitation {
  id: string;
  email: string;
  /** A role key: a built-in name or a custom role id. */
  role: string;
  teamId: string | null;
  teamName: string | null;
  invitedByName: string | null;
  createdAt: number;
  expiresAt: number;
  state: "pending" | "expired";
  delivery: InvitationDelivery;
  /** The mail server's answer when the mail failed. */
  deliveryDetail: string | null;
  deliveredAt: number | null;
}

export interface IssuedInvitation {
  invitation: Invitation;
  /** The link to pass on, when no mail server is set up. */
  link: string | null;
}

export interface CreatedInvitations {
  items: IssuedInvitation[];
  /** The mails went to the mail server. */
  mailed: boolean;
}

/** What the mail server said when it took a mail. */
export interface Delivered {
  reply: string;
  elapsedMs: number;
  tls: string | null;
  certificateNotAfter: number | null;
}

/** Addresses one request may invite. */
export const MAX_INVITE_EMAILS = 50;

const isText = (value: unknown) => typeof value === "string";
const isOptionalText = (value: unknown) => value === null || typeof value === "string";
const isOptionalNumber = (value: unknown) => value === null || typeof value === "number";

export function isInvitation(value: unknown): value is Invitation {
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.email) &&
    isText(value.role) &&
    isOptionalText(value.teamId) &&
    isOptionalText(value.teamName) &&
    isOptionalText(value.invitedByName) &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    (value.state === "pending" || value.state === "expired") &&
    ["none", "pending", "sent", "failed"].includes(String(value.delivery)) &&
    isOptionalText(value.deliveryDetail) &&
    isOptionalNumber(value.deliveredAt)
  );
}

function isIssued(value: unknown): value is IssuedInvitation {
  return isRecord(value) && isInvitation(value.invitation) && isOptionalText(value.link);
}

function isCreated(value: unknown): value is CreatedInvitations {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isIssued) &&
    typeof value.mailed === "boolean"
  );
}

function isPage(value: unknown): value is ListPage<Invitation> {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isInvitation) &&
    isOptionalText(value.nextCursor)
  );
}

export function isDelivered(value: unknown): value is Delivered {
  return (
    isRecord(value) &&
    isText(value.reply) &&
    typeof value.elapsedMs === "number" &&
    isOptionalText(value.tls) &&
    isOptionalNumber(value.certificateNotAfter)
  );
}

const enc = encodeURIComponent;

function path(orgId: string, rest = ""): string {
  return `/api/orgs/${enc(orgId)}/invitations${rest}`;
}

export const invitationKeys = {
  list: (orgId: string) => ["admin", "org", orgId, "invitations"] as const,
};

export async function listInvitations(orgId: string, cursor?: string) {
  const query = cursor === undefined ? "" : `?cursor=${enc(cursor)}`;
  return expectShape(await request("GET", path(orgId, query)), isPage, "invitations");
}

export async function createInvitations(
  orgId: string,
  input: { emails: string[]; role: string; teamId?: string },
): Promise<CreatedInvitations> {
  return expectShape(await request("POST", path(orgId), input), isCreated, "invitations");
}

export async function invitationLink(
  orgId: string,
  id: string,
): Promise<{ link: string; expiresAt: number }> {
  const answer = await request("GET", path(orgId, `/${enc(id)}/link`));
  return expectShape(
    answer,
    (value): value is { link: string; expiresAt: number } =>
      isRecord(value) && isText(value.link) && typeof value.expiresAt === "number",
    "invitation link",
  );
}

export async function resendInvitation(orgId: string, id: string): Promise<IssuedInvitation> {
  return expectShape(
    await request("POST", path(orgId, `/${enc(id)}/resend`), {}),
    isIssued,
    "invitation",
  );
}

export async function revokeInvitation(orgId: string, id: string): Promise<void> {
  await request("DELETE", path(orgId, `/${enc(id)}`));
}

/** Sends a member the link to set a new password. */
export async function sendPasswordLink(orgId: string, userId: string): Promise<Delivered> {
  return expectShape(
    await request("POST", `/api/orgs/${enc(orgId)}/members/${enc(userId)}/password-link`, {}),
    isDelivered,
    "password link",
  );
}

/**
 * Splits what was typed into addresses: by comma, semicolon, space or line break, without empty
 * pieces and repeats (compared in lower case, as the server does).
 */
export function splitEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\s,;]+/)) {
    const email = piece.trim();
    if (email !== "" && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      out.push(email);
    }
  }
  return out;
}

/** The rough shape the server accepts (`routes::normalize_email`); delivery proves the rest. */
export function looksLikeEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@") || email.length > 254) {
    return false;
  }
  const domain = email.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}
