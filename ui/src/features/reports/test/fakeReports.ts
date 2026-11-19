import {
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import type { Report, ReportInput, ReportRun, ReportsStatus } from "../api";

/**
 * The report routes of docs/api/reports.md for tests: status, the reports with their runs, the
 * preview and "send now", with the rights the server checks. Reports are off by default here, so
 * other areas' tests see no entry and no requests beyond the status. The server has its own
 * tests; this is close enough for the UI.
 */
export interface FakeReportsState {
  status: ReportsStatus;
  reports: Report[];
  runs: Record<string, ReportRun[]>;
  /** Members by id, as the recipients of a saved report are shown. */
  people: Record<string, { name: string; email: string }>;
  /** Refuses the next create or update with this error body, as the server's checks would. */
  refuse: {
    status: number;
    code: string;
    field?: string;
    reason: string;
    params?: Record<string, string>;
  } | null;
  /** The bodies of saves, previews and what was sent, for checking what the UI asked for. */
  saved: ReportInput[];
  previews: ReportInput[];
  sent: string[];
  /** The pause and resume requests, with the version each named. */
  paused: { id: string; paused: boolean; version: number }[];
}

export const FAKE_REPORTS_ON: ReportsStatus = {
  enabled: true,
  mailConfigured: true,
  allowExternalRecipients: false,
  externalDomains: [],
  limits: {
    maxReportsPerOrg: 100,
    maxRunsPerOrgHour: 60,
    maxRecipients: 20,
    maxAttachmentBytes: 10_000_000,
    historyRetentionDays: 90,
  },
  reports: 0,
};

/** A run as the server answers it; `patch` sets what a test is about. */
export function fakeRun(id: string, patch: Partial<ReportRun> = {}): ReportRun {
  return {
    id,
    trigger: "schedule",
    attempt: 1,
    triggeredBy: null,
    scheduledFor: Date.UTC(2026, 10, 9, 6),
    status: "ok",
    createdAt: Date.UTC(2026, 10, 9, 6),
    startedAt: Date.UTC(2026, 10, 9, 6),
    finishedAt: Date.UTC(2026, 10, 9, 6) + 4100,
    error: null,
    recipients: 3,
    sent: 3,
    skippedRecipients: 0,
    csvWithheld: 0,
    attachmentBytes: 214_000,
    pages: 3,
    ...patch,
  };
}

/** A stored report; `patch` sets what a test is about. */
export function fakeReport(id: string, patch: Partial<Report> = {}): Report {
  return {
    id,
    name: "Wochenbericht Vertrieb",
    description: "",
    dashboardId: "d1",
    dashboardTitle: "Verkauf Überblick",
    panelIds: null,
    timeRange: { from: "now-7d", to: "now" },
    variables: {},
    schedule: { kind: "weekly", time: "07:00", weekdays: ["mon"] },
    timeZone: "Europe/Berlin",
    formats: ["pdf"],
    language: "de",
    recipients: [{ userId: "u1", email: "ada@example.com", name: "Ada Lovelace", external: false }],
    paused: false,
    nextRunAt: Date.UTC(2026, 10, 16, 6),
    ownerId: "u1",
    ownerName: "Ada Lovelace",
    suspended: null,
    lastRun: null,
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    ...patch,
  };
}

function refusal(status: number, code: string, reason?: string) {
  return json(status, { error: { code, message: `server message for ${reason ?? code}`, reason } });
}

export function reportsFake(areas: FakeAreaStates): FakeArea<FakeReportsState> {
  let next = 1;
  const state: FakeReportsState = {
    status: { ...FAKE_REPORTS_ON, enabled: false },
    reports: [],
    runs: {},
    people: { u1: { name: "Ada Lovelace", email: "ada@example.com" } },
    refuse: null,
    saved: [],
    previews: [],
    sent: [],
    paused: [],
  };

  function stored(input: ReportInput, base: Report | undefined): Report {
    const dashboard = areas.dashboards.dashboards.find((d) => d.id === input.dashboardId);
    return {
      ...fakeReport(base?.id ?? `report-${next++}`),
      ...(base === undefined ? {} : { ownerId: base.ownerId, ownerName: base.ownerName }),
      name: input.name,
      description: input.description ?? "",
      dashboardId: input.dashboardId,
      dashboardTitle: dashboard?.versions.at(-1)?.model.title ?? "",
      panelIds: input.panelIds ?? null,
      timeRange: input.timeRange ?? null,
      variables: input.variables ?? {},
      schedule: input.schedule,
      timeZone: input.timeZone,
      formats: input.formats,
      language: input.language,
      recipients: (input.recipients ?? []).map((recipient) =>
        recipient.userId === undefined
          ? { email: recipient.email ?? null, external: true }
          : {
              userId: recipient.userId,
              email: state.people[recipient.userId]?.email ?? null,
              name: state.people[recipient.userId]?.name ?? "",
              external: false,
            },
      ),
      paused: input.paused ?? false,
      nextRunAt: input.paused === true ? null : Date.UTC(2026, 10, 16, 6),
      lastRun: base?.lastRun ?? null,
      version: (base?.version ?? 0) + 1,
    };
  }

  function save(input: ReportInput, base: Report | undefined): Response | Report {
    if (state.refuse !== null) {
      const { status, ...error } = state.refuse;
      state.refuse = null;
      return json(status, { error: { message: `server message for ${error.reason}`, ...error } });
    }
    state.saved.push(input);
    return stored(input, base);
  }

  return {
    state,
    handle: ({ method, route, body, permissions }: FakeRequest) => {
      const parts = route.split("/").slice(4);
      if (parts[0] !== "reports") return undefined;
      const [, id, sub] = parts;
      const input = body as unknown as ReportInput;
      const write = method !== "GET";
      if (!permissions.has(write ? "reports:write" : "reports:read")) {
        return refusal(403, "forbidden");
      }
      if (id === undefined) {
        if (method === "GET") {
          return json(200, { items: state.reports, nextCursor: null });
        }
        const made = save(input, undefined);
        if (made instanceof Response) return made;
        state.reports.unshift(made);
        return json(201, made);
      }
      if (id === "status") {
        return json(200, { ...state.status, reports: state.reports.length });
      }
      if (id === "preview") {
        state.previews.push(input);
        if (!state.status.enabled) return refusal(409, "conflict", "reports.disabled");
        return new Response(new Blob(["%PDF-1.7 fake"], { type: "application/pdf" }), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'inline; filename="wochenbericht.pdf"',
          },
        });
      }
      const report = state.reports.find((item) => item.id === id);
      if (report === undefined) return refusal(404, "not_found");
      if (sub === "runs") {
        return json(200, { items: state.runs[id] ?? [], nextCursor: null });
      }
      if (sub === "send") {
        if (!state.status.mailConfigured) {
          return refusal(409, "conflict", "reports.mail_not_configured");
        }
        state.sent.push(id);
        const run = fakeRun(`run-${next++}`, {
          trigger: "manual",
          status: "queued",
          scheduledFor: null,
          startedAt: null,
          finishedAt: null,
          attachmentBytes: null,
          sent: 0,
        });
        state.runs[id] = [run, ...(state.runs[id] ?? [])];
        return json(202, { run });
      }
      if (sub === "pause" || sub === "resume") {
        // Already in that state: answered as it is, whatever version was named.
        if (report.paused === (sub === "pause")) return json(200, report);
        if (body.version !== report.version) {
          return json(409, {
            error: { code: "version_conflict", message: "changed meanwhile" },
            current: report,
          });
        }
        // Resuming checks the report as a save would; pausing never does.
        if (sub === "resume" && state.refuse !== null) {
          const { status, ...error } = state.refuse;
          state.refuse = null;
          return json(status, {
            error: { message: `server message for ${error.reason}`, ...error },
          });
        }
        const paused = sub === "pause";
        state.paused.push({ id, paused, version: report.version });
        const changed: Report = {
          ...report,
          paused,
          nextRunAt: paused ? null : Date.UTC(2026, 10, 16, 6),
          version: report.version + 1,
        };
        state.reports = state.reports.map((item) => (item === report ? changed : item));
        return json(200, changed);
      }
      if (method === "DELETE") {
        state.reports = state.reports.filter((item) => item !== report);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        if (input.version !== report.version) {
          return json(409, {
            error: { code: "version_conflict", message: "changed meanwhile" },
            current: report,
          });
        }
        const changed = save(input, report);
        if (changed instanceof Response) return changed;
        state.reports = state.reports.map((item) => (item === report ? changed : item));
        return json(200, changed);
      }
      return json(200, report);
    },
  };
}
