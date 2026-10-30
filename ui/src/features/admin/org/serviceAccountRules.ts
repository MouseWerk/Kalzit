/**
 * The rules of service accounts and their tokens as the server applies them (docs/api/access.md,
 * "Service accounts"), checked before sending so mistakes show at the field. The server checks
 * again and has the last word.
 */

export const DAY_MS = 86_400_000;
/** A token lives at most this long, and this long unless chosen otherwise. */
export const MAX_TOKEN_DAYS = 365;
export const DEFAULT_TOKEN_DAYS = 90;
/** The expiry choices of the token dialog, in days. */
export const TOKEN_DAY_CHOICES = [30, 90, 180, 365] as const;
/** A row warns this long before its token expires. */
export const EXPIRY_WARNING_DAYS = 7;
export const MAX_ALLOWED_IPS = 50;
export const MAX_ACCOUNT_NAME = 50;

/** Lowercase letters, digits and hyphens, not starting with a hyphen. */
export function validAccountName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_ACCOUNT_NAME && /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function validIpv4(text: string): boolean {
  const parts = text.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part,
    )
  );
}

function validIpv6(text: string): boolean {
  if (!text.includes(":") || !/^[0-9a-fA-F:.]+$/.test(text)) {
    return false;
  }
  try {
    // The URL parser knows every IPv6 form, compressed and IPv4-mapped included.
    new URL(`http://[${text}]/`);
    return true;
  } catch {
    return false;
  }
}

/** One line of an IP allow list: an address, or a network with its prefix length. */
export function validIpEntry(entry: string): boolean {
  const [address = "", prefix, extra] = entry.split("/");
  if (extra !== undefined) {
    return false;
  }
  const v4 = validIpv4(address);
  if (!v4 && !validIpv6(address)) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (v4 ? 32 : 128);
}

export type AllowListCheck =
  | { ok: true; entries: string[] }
  | { ok: false; line: number; value: string }
  | { ok: false; tooMany: true };

/** The entries of the allow list text, one per line; empty lines are skipped. */
export function checkAllowList(text: string): AllowListCheck {
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (entries.length > MAX_ALLOWED_IPS) {
    return { ok: false, tooMany: true };
  }
  const index = entries.findIndex((entry) => !validIpEntry(entry));
  if (index >= 0) {
    return { ok: false, line: index + 1, value: entries[index] ?? "" };
  }
  return { ok: true, entries };
}

/** Whole days until `at`, rounded up, at least 0. */
export function daysUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / DAY_MS));
}

/** A token is in force: neither revoked nor expired. */
export function tokenActive(token: { revokedAt: number | null; expiresAt: number }, now: number) {
  return token.revokedAt === null && token.expiresAt > now;
}
