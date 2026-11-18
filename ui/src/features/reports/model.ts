import type { MessageKey, MessageParams, Translate } from "../../i18n/i18n";
import { fromWall, normalizeWall, type Wall, wallOf, weekdayOf } from "../../lib/zonedTime";
import type {
  Recipient,
  RecipientView,
  Report,
  ReportFormat,
  ReportInput,
  ReportLanguage,
  ReportRun,
  Schedule,
  Weekday,
} from "./api";

/**
 * The report editor's draft and what the list, the editor and the runs say about a report:
 * schedules in words, the next runs, which reports have a problem. Pure, so the tests cover it
 * without a page.
 */

export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const SCHEDULE_KINDS = ["daily", "weekly", "monthly", "cron"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];
export type FormatChoice = "pdf" | "csv" | "both";

/** A recipient in the editor: a member by account, or an address outside the organization. */
export interface DraftRecipient {
  userId?: string | undefined;
  email: string;
  name?: string | undefined;
}

export interface ReportDraft {
  name: string;
  description: string;
  dashboardId: string;
  /** Empty for the whole dashboard. */
  panelIds: string[];
  allPanels: boolean;
  /** `from|to`, or empty for the dashboard's own range. */
  range: string;
  /** A variable's fixed value as typed; empty follows the dashboard's saved value. */
  variables: Record<string, string>;
  kind: ScheduleKind;
  time: string;
  weekdays: Weekday[];
  day: string;
  cron: string;
  timeZone: string;
  format: FormatChoice;
  language: ReportLanguage;
  recipients: DraftRecipient[];
  paused: boolean;
}

export function emptyDraft(timeZone: string, language: ReportLanguage): ReportDraft {
  return {
    name: "",
    description: "",
    dashboardId: "",
    panelIds: [],
    allPanels: true,
    range: "",
    variables: {},
    kind: "weekly",
    time: "07:00",
    weekdays: ["mon"],
    day: "1",
    cron: "0 7 * * 1-5",
    timeZone,
    format: "pdf",
    language,
    recipients: [],
    paused: false,
  };
}

export const rangeValue = (range: { from: string; to: string } | null): string =>
  range === null ? "" : `${range.from}|${range.to}`;

function variableText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value ?? "");
}

export function draftFromReport(report: Report): ReportDraft {
  const base = emptyDraft(report.timeZone, report.language);
  const schedule = report.schedule;
  return {
    ...base,
    name: report.name,
    description: report.description,
    dashboardId: report.dashboardId,
    panelIds: report.panelIds ?? [],
    allPanels: report.panelIds === null,
    range: rangeValue(report.timeRange),
    variables: Object.fromEntries(
      Object.entries(report.variables).map(([name, value]) => [name, variableText(value)]),
    ),
    kind: schedule.kind,
    ...(schedule.kind === "cron" ? { cron: schedule.expression } : { time: schedule.time }),
    ...(schedule.kind === "weekly" ? { weekdays: schedule.weekdays } : {}),
    ...(schedule.kind === "monthly" ? { day: String(schedule.day) } : {}),
    format:
      report.formats.length > 1
        ? "both"
        : ((report.formats[0] as ReportFormat | undefined) ?? "pdf"),
    recipients: report.recipients.flatMap((recipient) => draftRecipient(recipient)),
    paused: report.paused,
  };
}

/** A member who left has no address any more and is not kept in the draft. */
function draftRecipient(recipient: RecipientView): DraftRecipient[] {
  if (recipient.email === null) return [];
  return [{ userId: recipient.userId, email: recipient.email, name: recipient.name }];
}

export function scheduleOf(draft: ReportDraft): Schedule {
  switch (draft.kind) {
    case "daily":
      return { kind: "daily", time: draft.time };
    case "weekly":
      return {
        kind: "weekly",
        time: draft.time,
        weekdays: WEEKDAYS.filter((day) => draft.weekdays.includes(day)),
      };
    case "monthly":
      return { kind: "monthly", time: draft.time, day: Number(draft.day) };
    case "cron":
      return { kind: "cron", expression: draft.cron.trim().replace(/\s+/g, " ") };
  }
}

/**
 * The request body of a draft. `multi` names the dashboard's variables that take several values:
 * theirs are sent as a list, split at commas.
 */
export function inputOf(
  draft: ReportDraft,
  multi: ReadonlySet<string> = new Set(),
  version?: number,
): ReportInput {
  const [from, to] = draft.range.split("|");
  const variables: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(draft.variables)) {
    const value = text.trim();
    if (value === "") continue;
    variables[name] = multi.has(name)
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
      : value;
  }
  const recipients: Recipient[] = draft.recipients.map((recipient) =>
    recipient.userId === undefined ? { email: recipient.email } : { userId: recipient.userId },
  );
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    dashboardId: draft.dashboardId,
    ...(draft.allPanels ? {} : { panelIds: draft.panelIds }),
    ...(from !== undefined && to !== undefined && draft.range !== ""
      ? { timeRange: { from, to } }
      : {}),
    variables,
    schedule: scheduleOf(draft),
    timeZone: draft.timeZone,
    formats: draft.format === "both" ? ["pdf", "csv"] : [draft.format],
    language: draft.language,
    recipients,
    paused: draft.paused,
    ...(version === undefined ? {} : { version }),
  };
}

export type DraftField =
  | "name"
  | "dashboardId"
  | "panelIds"
  | "timeRange"
  | "schedule"
  /** The day of a monthly schedule; the server names it with the schedule. */
  | "day"
  | "timeZone"
  | "formats"
  | "recipients";

export type DraftErrors = Partial<Record<DraftField, { key: MessageKey; params?: MessageParams }>>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the browser can tell before the server is asked; the server checks everything again. */
export function validateDraft(draft: ReportDraft, maxRecipients: number): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.name.trim() === "") errors.name = { key: "reports.reason.name_required" };
  if (draft.dashboardId === "") errors.dashboardId = { key: "reports.dashboardPick" };
  if (!draft.allPanels && draft.panelIds.length === 0) {
    errors.panelIds = { key: "reports.reason.panels_invalid" };
  }
  if (draft.kind === "cron") {
    if (draft.cron.trim().split(/\s+/).length !== 5) {
      errors.schedule = { key: "reports.reason.cron_invalid" };
    }
  } else if (!TIME.test(draft.time)) {
    errors.schedule = { key: "reports.reason.time_invalid" };
  } else if (draft.kind === "weekly" && draft.weekdays.length === 0) {
    errors.schedule = { key: "reports.reason.weekdays_invalid" };
  } else if (draft.kind === "monthly" && !/^([1-9]|[12]\d|3[01])$/.test(draft.day.trim())) {
    errors.day = { key: "reports.reason.day_invalid" };
  }
  if (draft.recipients.length === 0) {
    errors.recipients = { key: "reports.reason.recipients_required" };
  } else if (draft.recipients.length > maxRecipients) {
    errors.recipients = {
      key: "reports.reason.too_many_recipients",
      params: { max: maxRecipients },
    };
  }
  return errors;
}

/** Monday of a week that starts on a Monday, for naming weekdays through Intl. */
const MONDAY_MS = Date.UTC(2024, 0, 1);

export function weekdayName(language: string, day: Weekday, style: "short" | "long"): string {
  return new Intl.DateTimeFormat(language, { weekday: style, timeZone: "UTC" }).format(
    MONDAY_MS + WEEKDAYS.indexOf(day) * 86_400_000,
  );
}

/** "Täglich 06:30", "Mo, Fr 07:00", "Am 1. um 08:00", or the cron expression itself. */
export function scheduleText(t: Translate, language: string, schedule: Schedule): string {
  switch (schedule.kind) {
    case "daily":
      return t("reports.schedule.dailyAt", { time: schedule.time });
    case "weekly":
      return t("reports.schedule.weeklyAt", {
        days:
          schedule.weekdays.length === 1 && schedule.weekdays[0] !== undefined
            ? weekdayName(language, schedule.weekdays[0], "long")
            : schedule.weekdays.map((day) => weekdayName(language, day, "short")).join(", "),
        time: schedule.time,
      });
    case "monthly":
      return t("reports.schedule.monthlyAt", { day: schedule.day, time: schedule.time });
    case "cron":
      return schedule.expression;
  }
}

/**
 * The moment a local time stands for in `zone`, as the server reads it (reports/schedule.rs,
 * `instant`): the earlier one when the clocks go back, and in the gap when they go forward the
 * first minute after it, the one the clocks jump to (02:30 becomes 03:00).
 */
export function instantOf(wall: Wall, zone: string): number {
  for (let minutes = 0; minutes <= 24 * 60; minutes += 1) {
    const local = normalizeWall({ ...wall, minute: wall.minute + minutes });
    const at = fromWall(local, zone);
    const read = wallOf(at, zone);
    if (read.hour === local.hour && read.minute === local.minute && read.day === local.day) {
      return at;
    }
  }
  return fromWall(wall, zone);
}

/**
 * The next times a schedule runs after `now`, in the report's zone. A monthly day a month does
 * not have runs on its last day, as on the server. Cron expressions are not read here: the
 * server names their next run once the report is saved.
 */
export function nextRuns(schedule: Schedule, zone: string, now: number, count = 3): number[] {
  if (schedule.kind === "cron") return [];
  const [hour, minute] = schedule.time.split(":").map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return [];
  }
  const out: number[] = [];
  const start = wallOf(now, zone);
  // Day by day from today; 366 days cover every schedule, also the 31st.
  for (let offset = 0; offset < 366 && out.length < count; offset += 1) {
    const day = normalizeWall({
      ...start,
      day: start.day + offset,
      hour: 12,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    if (schedule.kind === "weekly") {
      const name = WEEKDAYS[(weekdayOf(day) + 6) % 7];
      if (name === undefined || !schedule.weekdays.includes(name)) continue;
    }
    if (schedule.kind === "monthly") {
      const last = new Date(Date.UTC(day.year, day.month, 0)).getUTCDate();
      if (day.day !== Math.min(schedule.day, last)) continue;
    }
    const at = instantOf({ ...day, hour, minute, second: 0, millisecond: 0 }, zone);
    if (at > now) out.push(at);
  }
  return out;
}

/** Whether a recipient still gets the report: a member who left has no address any more. */
export function reachable(recipient: { email?: string | null | undefined }): boolean {
  return recipient.email !== null;
}

/**
 * Recipients as the list counts them: "6", or "6 + 1 extern" with outside addresses. Members
 * who left the organization are in no run and are not counted.
 */
export function recipientsText(
  t: Translate,
  recipients: readonly { userId?: string | undefined; email?: string | null | undefined }[],
): string {
  const left = recipients.filter(reachable);
  const external = left.filter((recipient) => recipient.userId === undefined).length;
  const members = left.length - external;
  return external === 0
    ? String(members)
    : t("reports.recipients.mixed", { count: members, external });
}

export function formatsText(formats: readonly ReportFormat[]): string {
  return formats.map((format) => format.toUpperCase()).join(", ");
}

/** A run that went wrong, or did not happen although it should have. */
export function runFailed(run: ReportRun | null): boolean {
  return run !== null && (run.status === "failed" || run.status === "suspended");
}

/** Suspended, or the last run failed: what "Mit Problemen" lists. */
export function hasProblem(report: Report): boolean {
  return report.suspended !== null || runFailed(report.lastRun);
}

/** How long a finished run took, in seconds with one decimal; null while it runs. */
export function runSeconds(run: ReportRun): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  return Math.max(0, run.finishedAt - run.startedAt) / 1000;
}

/** An address as people type it: one `@` with something on both sides and a dot after it. */
export function looksLikeEmail(text: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}
