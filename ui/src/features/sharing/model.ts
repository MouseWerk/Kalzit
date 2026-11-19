import type {
  PublicVariable,
  ShareStatus,
  SuspendedReason,
  TimeRange,
} from "../../api/generated/shapes";
import type { MessageKey, Translate } from "../../i18n/i18n";
import { withBase } from "../../lib/basePath";
import { zoneOption } from "../../lib/timeSettings";
import { type Share, shareOf } from "./api";

/*
 * What the sharing screens work out from the API's values: choices for expiry and window, the
 * status a list shows, addresses for visitors and sizes in words (board Sharing.dc.html).
 */

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The expiry preselected when sharing; the server's own default. */
export const DEFAULT_EXPIRY_DAYS = 30;
/** The longest expiry a server allows unless its administrators changed it. */
export const DEFAULT_MAX_EXPIRY_DAYS = 365;
export const DEFAULT_WINDOW_MS = 7 * DAY_MS;
/** The size limit of a snapshot unless the server's administrators changed it. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024;

const EXPIRY_DAYS = [1, 7, 30, 90, 180, 365] as const;

/** The expiry choices within the server's longest expiry, which is itself always a choice. */
export function expiryChoices(maxDays: number): number[] {
  const within = EXPIRY_DAYS.filter((days) => days < maxDays);
  return [...within, maxDays];
}

/** The choice preselected: 30 days, or the longest allowed when that is shorter. */
export function defaultExpiryDays(maxDays: number): number {
  return Math.min(DEFAULT_EXPIRY_DAYS, maxDays);
}

/**
 * When a share made now with `days` expires. At the longest expiry it stays a minute inside:
 * the server counts the limit from its own clock, a moment later than the browser's.
 */
export function expiryAt(days: number, maxDays: number | undefined, now = Date.now()): number {
  return now + days * DAY_MS - (maxDays !== undefined && days >= maxDays ? 60_000 : 0);
}

/** How far back visitors may look, as the dialog offers it. */
export const WINDOW_CHOICES: readonly number[] = [
  HOUR_MS,
  6 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
  30 * DAY_MS,
  90 * DAY_MS,
];

/**
 * A length of time in words: "7 days", "6 hours", "1 year". `plural` keeps it in a plural unit
 * ("24 hours", not "1 day"), for sentences such as "within the last ...".
 */
export function durationText(t: Translate, ms: number, plural = false): string {
  const days = ms / DAY_MS;
  if (days >= 365 && days % 365 === 0 && !(plural && days === 365)) {
    const years = days / 365;
    return t(years === 1 ? "sharing.duration.year" : "sharing.duration.years", { count: years });
  }
  if (days >= 1 && Number.isInteger(days) && !(plural && days === 1)) {
    return t(days === 1 ? "sharing.duration.day" : "sharing.duration.days", { count: days });
  }
  const hours = Math.max(1, Math.round(ms / HOUR_MS));
  if (ms >= HOUR_MS && !(plural && hours === 1)) {
    return t(hours === 1 ? "sharing.duration.hour" : "sharing.duration.hours", { count: hours });
  }
  return t("sharing.duration.minutes", { count: Math.max(2, Math.round(ms / 60_000)) });
}

/** An expiry choice as the select reads it: "after 30 days", "after 1 year". */
export function afterText(t: Translate, days: number): string {
  if (days >= 365 && days % 365 === 0) {
    const years = days / 365;
    return t(years === 1 ? "sharing.afterYear" : "sharing.afterYears", { count: years });
  }
  return t(days === 1 ? "sharing.afterDay" : "sharing.afterDays", { count: days });
}

/** A day as people read it: "14.12.2026". */
export function dateText(ms: number, language: string, zone: string | null): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", ...zoneOption(zone) }).format(ms);
}

/** A point in time: "14.11.2026, 10:42". */
export function dateTimeText(ms: number, language: string, zone: string | null): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(zone),
  }).format(ms);
}

/** A fixed range as text: "13.11.2026, 10:42 – 14.11.2026, 10:42". */
export function fixedRangeText(range: TimeRange, language: string, zone: string | null): string {
  return `${dateTimeText(range.from, language, zone)} – ${dateTimeText(range.to, language, zone)}`;
}

/** A size in the unit people expect: "412 KB", "1.6 MB". */
export function bytesText(bytes: number, language: string): string {
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
  if (bytes >= 1024 * 1024 * 1024) return `${format(bytes / 1024 ** 3, 1)} GB`;
  if (bytes >= 1024 * 1024) return `${format(bytes / 1024 ** 2, 1)} MB`;
  if (bytes >= 1024) return `${format(bytes / 1024, 0)} KB`;
  return `${format(bytes, 0)} B`;
}

/** The page a visitor opens for a public link or public snapshot. */
export function publicUrl(kind: "link" | "snapshot", token: string): string {
  const path = kind === "link" ? "/public/dashboards/" : "/public/snapshots/";
  return new URL(withBase(`${path}${encodeURIComponent(token)}`), window.location.origin).href;
}

/** The status a list shows: the server's, with "expires soon" for an active one's last week. */
export type ShownStatus = ShareStatus | "expiresSoon";

export const SOON_MS = 7 * DAY_MS;

export function shownStatus(share: Share, now: number): ShownStatus {
  const item = shareOf(share);
  // Internal snapshots carry no status for people who did not make them: they are open.
  const status: ShareStatus = item.status ?? "active";
  if (status === "active" && item.expiresAt <= now) return "expired";
  if (status === "active" && item.expiresAt - now <= SOON_MS) return "expiresSoon";
  return status;
}

export const STATUS_TEXT: Record<ShownStatus, MessageKey> = {
  active: "sharing.status.active",
  expiresSoon: "sharing.status.expiresSoon",
  suspended: "sharing.status.suspended",
  expired: "sharing.status.expired",
  revoked: "sharing.status.revoked",
};

const REASON_TEXT: Record<SuspendedReason, MessageKey> = {
  sharingOff: "sharing.suspended.sharingOff",
  creatorRemoved: "sharing.suspended.creatorRemoved",
  creatorRights: "sharing.suspended.creatorRights",
  dashboardTrashed: "sharing.suspended.dashboardTrashed",
};

/** Why a link or public snapshot is suspended, for its creator and the admins. */
export function suspendedText(t: Translate, reason: SuspendedReason | undefined): string {
  return t(reason === undefined ? "sharing.suspended.unknown" : REASON_TEXT[reason]);
}

/** The name a list shows: a snapshot's title, a link's dashboard. */
export function shareName(t: Translate, share: Share): string {
  if (share.kind === "snapshot") return share.snapshot.title;
  return share.link.dashboardTitle ?? t("sharing.list.hiddenDashboard");
}

export function kindText(t: Translate, share: Share): string {
  if (share.kind === "link") return t("sharing.kind.link");
  return t(share.snapshot.public ? "sharing.kind.snapshotPublic" : "sharing.kind.snapshotOrg");
}

/** A fixed variable value as text; several values are joined by commas. */
export function fixedValueText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  return value === undefined || value === null ? "" : String(value);
}

/** The variables a public page shows, each with its fixed value as text. */
export function fixedVariables(
  variables: readonly PublicVariable[],
): { name: string; label: string; value: string }[] {
  return variables.map((variable) => ({
    name: variable.name,
    label: variable.label === undefined || variable.label === "" ? variable.name : variable.label,
    value: fixedValueText(variable.value),
  }));
}

/** `yyyy-mm-dd` for a date input, in the browser's zone (the end of that day is what counts). */
export function toDateInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The end of the day a date input names, in the browser's zone; undefined for anything else. */
export function fromDateInput(text: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const time = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    23,
    59,
    0,
    0,
  ).getTime();
  return Number.isFinite(time) ? time : undefined;
}

/** The ranges a visitor may pick, by how far back each reaches. */
export const VISITOR_PRESETS: readonly { ms: number; label: MessageKey }[] = [
  { ms: 15 * 60_000, label: "dashboards.time.last15m" },
  { ms: HOUR_MS, label: "dashboards.time.last1h" },
  { ms: 6 * HOUR_MS, label: "dashboards.time.last6h" },
  { ms: DAY_MS, label: "dashboards.time.last24h" },
  { ms: 2 * DAY_MS, label: "dashboards.time.last2d" },
  { ms: 7 * DAY_MS, label: "dashboards.time.last7d" },
  { ms: 30 * DAY_MS, label: "dashboards.time.last30d" },
  { ms: 90 * DAY_MS, label: "dashboards.time.last90d" },
];

/**
 * How far inside the window's start a visitor's range stays: the request arrives a moment after
 * the range was worked out, and the server counts the window from its own clock then. Two
 * minutes, or a quarter of a window shorter than eight.
 */
export function windowMargin(maxWindowMs: number): number {
  return Math.min(120_000, Math.floor(maxWindowMs / 4));
}

/**
 * A visitor's range held inside the link's window: nothing before `now - maxWindowMs` (and its
 * margin), nothing after now. `clamped` says the range asked for reached further back than the
 * window itself; a range that only touches the margin is not called limited.
 */
export function clampToWindow(
  range: TimeRange,
  maxWindowMs: number,
  now: number,
  margin = windowMargin(maxWindowMs),
): { range: TimeRange; clamped: boolean } {
  const earliest = now - maxWindowMs + margin;
  const least = Math.min(60_000, Math.max(1, maxWindowMs - margin));
  const to = Math.min(Math.max(range.to, earliest + least), now);
  const from = Math.min(Math.max(range.from, earliest), to - least);
  return { range: { from, to }, clamped: range.from < now - maxWindowMs };
}
