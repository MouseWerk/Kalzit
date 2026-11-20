import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { translate } from "../../i18n/i18n";
import { BUILT_IN_ROLE_PERMISSIONS, installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { pickOption } from "../../test/select";
import { emptyModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { PG_ID } from "../datasources/test/fakeDatasources";
import {
  draftFromReport,
  emptyDraft,
  hasProblem,
  inputOf,
  instantOf,
  nextRuns,
  type ReportDraft,
  recipientsText,
  scheduleText,
  validateDraft,
} from "./model";
import { codeText } from "./reasons";
import { FAKE_REPORTS_ON, fakeReport, fakeRun } from "./test/fakeReports";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params ?? {});
const de = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("de", key, params ?? {});

const wall = (year: number, month: number, day: number, hour: number, minute: number) => ({
  year,
  month,
  day,
  hour,
  minute,
  second: 0,
  millisecond: 0,
});

function filled(patch: Partial<ReportDraft> = {}): ReportDraft {
  return {
    ...emptyDraft("Europe/Berlin", "de"),
    name: " Wochenbericht Vertrieb ",
    dashboardId: "d1",
    recipients: [
      { userId: "u2", name: "Grace Hopper", email: "grace@example.com" },
      { email: "einkauf@spedition-krause.test" },
    ],
    ...patch,
  };
}

describe("report editor logic", () => {
  it("turns a filled draft into the documented request body", () => {
    const draft = filled({
      allPanels: false,
      panelIds: ["p1", "p4"],
      range: "now-1w/w|now-1w/w",
      variables: { region: " nord ", produkt: "", lager: "a, b" },
      format: "both",
    });
    expect(validateDraft(draft, 20)).toEqual({});
    expect(inputOf(draft, new Set(["lager"]), 3)).toEqual({
      name: "Wochenbericht Vertrieb",
      description: "",
      dashboardId: "d1",
      panelIds: ["p1", "p4"],
      timeRange: { from: "now-1w/w", to: "now-1w/w" },
      variables: { region: "nord", lager: ["a", "b"] },
      schedule: { kind: "weekly", time: "07:00", weekdays: ["mon"] },
      timeZone: "Europe/Berlin",
      formats: ["pdf", "csv"],
      language: "de",
      recipients: [{ userId: "u2" }, { email: "einkauf@spedition-krause.test" }],
      paused: false,
      version: 3,
    });
  });

  it("leaves out panels and range for the whole dashboard with its own range", () => {
    const input = inputOf(filled());
    expect(input).not.toHaveProperty("panelIds");
    expect(input).not.toHaveProperty("timeRange");
    expect(input).not.toHaveProperty("version");
  });

  it("names what is missing before the server is asked", () => {
    const errors = validateDraft(
      filled({
        name: " ",
        dashboardId: "",
        allPanels: false,
        kind: "weekly",
        weekdays: [],
        recipients: [],
      }),
      20,
    );
    expect(Object.keys(errors).sort()).toEqual([
      "dashboardId",
      "name",
      "panelIds",
      "recipients",
      "schedule",
    ]);
    expect(validateDraft(filled({ kind: "monthly", day: "32" }), 20).day?.key).toBe(
      "reports.reason.day_invalid",
    );
    expect(validateDraft(filled({ kind: "cron", cron: "0 7 * *" }), 20).schedule?.key).toBe(
      "reports.reason.cron_invalid",
    );
    expect(validateDraft(filled(), 1).recipients).toEqual({
      key: "reports.reason.too_many_recipients",
      params: { max: 1 },
    });
  });

  it("reads a stored report back into the draft it was saved from", () => {
    const report = fakeReport("r1", {
      panelIds: ["p2"],
      schedule: { kind: "monthly", time: "08:00", day: 1 },
      formats: ["pdf", "csv"],
      variables: { region: "nord", lager: ["a", "b"] },
      recipients: [
        { userId: "u2", email: "grace@example.com", name: "Grace Hopper", external: false },
        // Left the organization: no address any more, in no run, not sent back.
        { userId: "u9", email: null, external: false },
        { email: "einkauf@spedition-krause.test", external: true },
      ],
    });
    const draft = draftFromReport(report);
    expect(draft).toMatchObject({
      allPanels: false,
      panelIds: ["p2"],
      kind: "monthly",
      time: "08:00",
      day: "1",
      format: "both",
      range: "now-7d|now",
      variables: { region: "nord", lager: "a, b" },
    });
    expect(inputOf(draft, new Set(["lager"])).recipients).toEqual([
      { userId: "u2" },
      { email: "einkauf@spedition-krause.test" },
    ]);
  });

  it("says a schedule in words, in both languages", () => {
    expect(scheduleText(de, "de", { kind: "daily", time: "06:30" })).toBe("Täglich 06:30");
    expect(scheduleText(de, "de", { kind: "weekly", time: "07:00", weekdays: ["mon"] })).toBe(
      "Montag 07:00",
    );
    expect(scheduleText(t, "en", { kind: "weekly", time: "07:00", weekdays: ["mon", "fri"] })).toBe(
      "Mon, Fri 07:00",
    );
    expect(scheduleText(de, "de", { kind: "monthly", time: "08:00", day: 1 })).toBe(
      "Am 1. um 08:00",
    );
    expect(scheduleText(t, "en", { kind: "cron", expression: "30 7 * * 1-5" })).toBe(
      "30 7 * * 1-5",
    );
  });

  it("keeps the local time of the next runs across a change of the clocks", () => {
    // Saturday 2026-10-24 in Berlin; summer time ends on Sunday the 25th.
    const now = Date.UTC(2026, 9, 24, 10);
    expect(nextRuns({ kind: "daily", time: "07:00" }, "Europe/Berlin", now)).toEqual([
      Date.UTC(2026, 9, 25, 6),
      Date.UTC(2026, 9, 26, 6),
      Date.UTC(2026, 9, 27, 6),
    ]);
    expect(
      nextRuns({ kind: "weekly", time: "07:00", weekdays: ["mon"] }, "Europe/Berlin", now, 2),
    ).toEqual([Date.UTC(2026, 9, 26, 6), Date.UTC(2026, 10, 2, 6)]);
    // The 31st runs on the last day of shorter months.
    expect(
      nextRuns({ kind: "monthly", time: "08:00", day: 31 }, "UTC", Date.UTC(2027, 0, 31, 9), 2),
    ).toEqual([Date.UTC(2027, 1, 28, 8), Date.UTC(2027, 2, 31, 8)]);
    expect(nextRuns({ kind: "cron", expression: "0 7 * * *" }, "UTC", now)).toEqual([]);
  });

  it("runs a time the clocks skip at the first moment after the gap, as the server does", () => {
    // Berlin, 2027-03-28: 02:00 becomes 03:00. Daily 02:30 runs at 03:00 summer time that day.
    expect(
      nextRuns({ kind: "daily", time: "02:30" }, "Europe/Berlin", Date.UTC(2027, 2, 27, 12), 2),
    ).toEqual([Date.UTC(2027, 2, 28, 1), Date.UTC(2027, 2, 29, 0, 30)]);
    // New York, 2027-03-14: 02:00 becomes 03:00 (UTC-4 from then on).
    expect(
      nextRuns({ kind: "daily", time: "02:30" }, "America/New_York", Date.UTC(2027, 2, 13, 12), 1),
    ).toEqual([Date.UTC(2027, 2, 14, 7)]);
    // Lord Howe, 2026-10-04: 02:00 becomes 02:30, half an hour (UTC+11 from then on).
    expect(
      nextRuns({ kind: "daily", time: "02:15" }, "Australia/Lord_Howe", Date.UTC(2026, 9, 3, 0), 1),
    ).toEqual([Date.UTC(2026, 9, 3, 15, 30)]);
    // A time that exists is itself, and one that happens twice is the first of the two.
    expect(instantOf(wall(2027, 3, 28, 3, 0), "Europe/Berlin")).toBe(Date.UTC(2027, 2, 28, 1));
    expect(instantOf(wall(2026, 10, 25, 2, 30), "Europe/Berlin")).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    );
  });

  it("counts outside addresses apart and knows which reports have a problem", () => {
    expect(recipientsText(t, [{ userId: "u1" }, { userId: "u2" }])).toBe("2");
    expect(recipientsText(t, [{ userId: "u1" }, {}])).toBe("1 + 1 outside");
    // A member who left the organization is in no run and is not counted.
    expect(recipientsText(t, [{ userId: "u1" }, { userId: "u9", email: null }])).toBe("1");
    expect(hasProblem(fakeReport("r1"))).toBe(false);
    expect(hasProblem(fakeReport("r1", { lastRun: fakeRun("x", { status: "failed" }) }))).toBe(
      true,
    );
    expect(
      hasProblem(
        fakeReport("r1", {
          suspended: { code: "reports.creator_no_dashboard", message: "", since: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("translates a reason it knows and keeps the server's text for one it does not", () => {
    expect(codeText(t, { code: "reports.all_refused", message: "x" })).toBe(
      "The mail server refused every recipient.",
    );
    expect(codeText(t, { code: "reports.something_new", message: "from the server" })).toBe(
      "from the server",
    );
    expect(codeText(t, { code: "reports.something_new", message: "" })).toBe(
      t("reports.reason.internal"),
    );
  });
});

function open(
  path: string,
  role: string,
  setup?: (server: ReturnType<typeof installFakeServer>) => void,
  options: Parameters<typeof installFakeServer>[0] = {},
) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "MouseWerk", role }] },
    ...options,
  });
  server.areas.reports.status = { ...FAKE_REPORTS_ON };
  setup?.(server);
  return { server, ...renderApp(path) };
}

/** A dashboard with two panels and a variable, as the editor reads it. */
function addSales(server: ReturnType<typeof installFakeServer>) {
  const model = emptyModel("Verkauf Überblick");
  for (const [id, title] of [
    ["p1", "Umsatz heute"],
    ["p2", "Umsatz je Region"],
  ] as const) {
    model.panels.push({
      id,
      type: "stat",
      title,
      grid: { x: id === "p1" ? 0 : 12, y: 0, w: 12, h: 8 },
      targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1 AS v" } }],
      transformations: [],
      options: {},
      fieldConfig: {},
    });
  }
  model.variables.push({ name: "region", type: "custom", options: ["Nord", "Süd"] });
  addDashboard(server.areas.dashboards, "d1", model);
}

describe("Reports pages", () => {
  it("lists the reports after Alerting, with content, schedule, recipients and states", async () => {
    const { user } = open("/reports", "editor", (s) => {
      s.areas.reports.reports = [
        fakeReport("r1", {
          recipients: [
            { userId: "u1", email: "ada@example.com", name: "Ada Lovelace", external: false },
            { email: "einkauf@spedition-krause.test", external: true },
          ],
          lastRun: fakeRun("x1"),
        }),
        fakeReport("r2", {
          name: "Monatsabschluss",
          panelIds: ["p1", "p2"],
          ownerId: "u7",
          ownerName: "Tim Berger",
          nextRunAt: null,
          suspended: { code: "reports.creator_no_dashboard", message: "", since: 0 },
        }),
        fakeReport("r3", { name: "Kühlhaus Nachtwerte", paused: true, nextRunAt: null }),
      ];
    });
    const nav = await screen.findByRole("navigation", { name: t("nav.label") });
    const entry = await within(nav).findByRole("link", { name: "Reports" });
    expect(entry.getAttribute("href")).toBe("/reports");
    const row = (await screen.findByRole("link", { name: "Wochenbericht Vertrieb" })).closest("tr");
    if (row === null) throw new Error("no row");
    expect(within(row).getByText("Verkauf Überblick · whole dashboard")).toBeTruthy();
    expect(within(row).getByText("Monday 07:00")).toBeTruthy();
    expect(within(row).getByText("1 + 1 outside")).toBeTruthy();
    expect(within(row).getByText("sent")).toBeTruthy();
    expect(screen.getByText("Verkauf Überblick · panels: 2")).toBeTruthy();
    // Suspended and paused are words, and the suspended one says why under the list.
    expect(screen.getByText("suspended")).toBeTruthy();
    expect(screen.getByText("paused")).toBeTruthy();
    expect(screen.getByText("Monatsabschluss is suspended:")).toBeTruthy();
    expect(screen.getByText(new RegExp(t("reports.reason.creator_no_dashboard")))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /With problems/ }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Wochenbericht Vertrieb" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "Monatsabschluss" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Mine/ }));
    expect(await screen.findByRole("link", { name: "Kühlhaus Nachtwerte" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Monatsabschluss" })).toBeNull();
  });

  it("shows one line and no table header when no report matches the search", async () => {
    const { user } = open("/reports", "editor", (s) => {
      s.areas.reports.reports = [fakeReport("r1")];
    });
    const table = await screen.findByRole("table");
    // Each cell names its column for the stacked form on a phone.
    const row = within(table).getAllByRole("row")[1] as HTMLElement;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.dataset.label ?? ""),
    ).toEqual(["", "Schedule", "Format", "Recipients", "Next run", "Last run", "Created by", ""]);
    // The field's name is the long one; the placeholder is short enough not to be cut.
    const field = screen.getByRole("searchbox", { name: "Search reports and dashboards" });
    expect(field.getAttribute("placeholder")).toBe("Search reports");
    await user.type(field, "zzz");
    expect(await screen.findByText("No report matches.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("has no entry while reports are off, and viewers see neither entry nor list", async () => {
    const off = open("/", "owner", (s) => {
      s.areas.reports.status = { ...FAKE_REPORTS_ON, enabled: false };
    });
    const nav = await screen.findByRole("navigation", { name: t("nav.label") });
    await waitFor(() =>
      expect(off.server.calls.some((call) => call.path.endsWith("/reports/status"))).toBe(true),
    );
    expect(within(nav).queryByRole("link", { name: "Reports" })).toBeNull();
    expect(off.server.calls.some((call) => call.path.endsWith("/reports"))).toBe(false);
    off.view.unmount();

    const viewer = open("/reports", "viewer");
    expect(await screen.findByText(t("reports.forbidden.title"))).toBeTruthy();
    expect(viewer.server.calls.some((call) => call.path.includes("/reports"))).toBe(false);
  });

  it("starts empty with the first step, and says when the mail server is missing", async () => {
    open("/reports", "editor", (s) => {
      s.areas.reports.status = { ...FAKE_REPORTS_ON, mailConfigured: false };
    });
    expect(await screen.findByRole("heading", { name: t("reports.empty.title") })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /New report/ }).length).toBeGreaterThan(0);
    expect(await screen.findByRole("heading", { name: t("reports.noMail.title") })).toBeTruthy();
    // Only server admins get the way to the mail settings.
    expect(screen.queryByRole("link", { name: t("reports.noMail.link") })).toBeNull();
  });

  it("leads server admins to the mail settings", async () => {
    open(
      "/reports",
      "owner",
      (s) => {
        s.areas.reports.status = { ...FAKE_REPORTS_ON, mailConfigured: false };
      },
      { user: { ...TEST_USER, orgs: [{ id: "o1", name: "MouseWerk", role: "owner" }] } },
    );
    const link = await screen.findByRole("link", { name: t("reports.noMail.link") });
    expect(link.getAttribute("href")).toBe("/settings/email");
  });

  it("creates a report: dashboard, panels, schedule, a member as recipient, then save", async () => {
    const { user, server, location } = open("/reports/new", "editor", addSales);
    await user.type(await screen.findByLabelText("Name"), "Wochenbericht Vertrieb");
    await pickOption(user, screen.getByLabelText("Dashboard"), "Verkauf Überblick");
    await user.click(await screen.findByRole("radio", { name: "Selected panels" }));
    await user.click(await screen.findByRole("checkbox", { name: "Umsatz je Region" }));
    await pickOption(user, screen.getByLabelText("region"), "Nord");
    await user.click(screen.getByRole("radio", { name: "Daily" }));
    expect(screen.getByText(/Next runs:/)).toBeTruthy();
    const add = screen.getByLabelText(t("reports.recipients.add"));
    await user.type(add, "Grace Hopper{Enter}");
    expect(screen.getByRole("button", { name: "Remove Grace Hopper" })).toBeTruthy();
    expect(screen.getByText("1 of 20")).toBeTruthy();
    // The summary follows the form.
    const summary = screen.getByRole("complementary", { name: "Summary" });
    expect(within(summary).getByText("Verkauf Überblick · panels: 1")).toBeTruthy();
    expect(within(summary).getByText(/Daily 07:00/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location().pathname).toBe("/reports/report-1"));
    expect(server.areas.reports.saved[0]).toMatchObject({
      name: "Wochenbericht Vertrieb",
      dashboardId: "d1",
      panelIds: ["p2"],
      variables: { region: "Nord" },
      schedule: { kind: "daily", time: "07:00" },
      formats: ["pdf"],
      recipients: [{ userId: "u2" }],
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Wochenbericht Vertrieb" }),
    ).toBeTruthy();
  });

  it("shows what is missing at its field and asks the server for nothing", async () => {
    const { user, server } = open("/reports/new", "editor", addSales);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText(t("reports.reason.name_required"))).toBeTruthy();
    expect(screen.getByText(t("reports.reason.recipients_required"))).toBeTruthy();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(server.areas.reports.saved).toEqual([]);
  });

  it("shows the server's refusal at the recipients, on the person it names", async () => {
    const { user } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.people.u3 = { name: "Alan Turing", email: "alan@example.com" };
      s.areas.reports.reports = [
        fakeReport("r1", {
          recipients: [
            { userId: "u1", email: "ada@example.com", name: "Ada Lovelace", external: false },
            { userId: "u3", email: "alan@example.com", name: "Alan Turing", external: false },
          ],
        }),
      ];
      s.areas.reports.refuse = {
        status: 422,
        code: "validation",
        field: "recipients",
        reason: "reports.recipient_no_access",
        params: { index: "1", name: "Alan Turing" },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Save" }));
    const error = await screen.findByText("Alan Turing cannot read the dashboard.");
    const field = screen.getByLabelText(t("reports.recipients.add"));
    expect(field.getAttribute("aria-describedby")).toBe(error.closest("p")?.id);
    const chip = screen.getByRole("button", { name: "Remove Alan Turing" }).closest("li");
    expect(chip?.className).toContain("report-chip--refused");
    expect(within(chip as HTMLElement).getByText("refused")).toBeTruthy();

    // Removing someone else moves nobody into the refused place: the mark and the error go,
    // and the next save asks the server again.
    await user.click(screen.getByRole("button", { name: "Remove Ada Lovelace" }));
    expect(screen.queryByText("refused")).toBeNull();
    expect(screen.queryByText("Alan Turing cannot read the dashboard.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Alan Turing" }).closest("li")?.className,
    ).not.toContain("report-chip--refused");
  });

  it("shows a wrong day of the month at the day field and puts the focus there", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [
        fakeReport("r1", { schedule: { kind: "monthly", time: "08:00", day: 1 } }),
      ];
    });
    const day = await screen.findByLabelText("Day of the month");
    await user.clear(day);
    await user.type(day, "32");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(t("reports.reason.day_invalid"))).toBeTruthy();
    expect(day.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(day);
    expect(server.areas.reports.saved).toEqual([]);
  });

  it("says once that a recipient left the organization, and does not count them", async () => {
    const gone = fakeReport("r1", {
      recipients: [
        { userId: "u1", email: "ada@example.com", name: "Ada Lovelace", external: false },
        { userId: "u9", email: null, external: false },
      ],
    });
    const { view } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [gone];
    });
    expect(
      await screen.findByText("No longer in the organization, dropped on save: 1"),
    ).toBeTruthy();
    expect(screen.getByText("1 of 20")).toBeTruthy();
    view.unmount();
    open("/reports", "editor", (s) => {
      s.areas.reports.reports = [gone];
    });
    const row = (await screen.findByRole("link", { name: "Wochenbericht Vertrieb" })).closest("tr");
    expect(within(row as HTMLElement).getByText("1")).toBeTruthy();
  });

  it("shows no empty placeholders before a dashboard is chosen", async () => {
    open("/reports/new", "editor", addSales);
    const summary = await screen.findByRole("complementary", { name: "Summary" });
    expect(within(summary).getByText("As saved in the dashboard")).toBeTruthy();
    expect(screen.queryByText(/“”/)).toBeNull();
    expect(screen.queryByText(/As in the dashboard:\s*$/)).toBeNull();
  });

  it("takes outside addresses only where the organization allows them", async () => {
    const { user } = open("/reports/new", "editor", addSales);
    const add = await screen.findByLabelText(t("reports.recipients.add"));
    await user.type(add, "einkauf@spedition-krause.test{Enter}");
    expect(await screen.findByText(t("reports.reason.external_not_allowed"))).toBeTruthy();
    expect(
      screen.getByText("Outside addresses are off in MouseWerk.", { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove einkauf/ })).toBeNull();
  });

  it("adds an outside address as a chip when the organization allows it", async () => {
    const { user } = open("/reports/new", "editor", (s) => {
      addSales(s);
      s.areas.reports.status = {
        ...FAKE_REPORTS_ON,
        allowExternalRecipients: true,
        externalDomains: ["spedition-krause.test"],
      };
    });
    const add = await screen.findByLabelText(t("reports.recipients.add"));
    await screen.findByText("Outside addresses only from: spedition-krause.test.", {
      exact: false,
    });
    await user.type(add, "Einkauf@spedition-krause.test{Enter}");
    expect(
      await screen.findByRole("button", { name: "Remove einkauf@spedition-krause.test" }),
    ).toBeTruthy();
    await user.type(add, "not an address{Enter}");
    expect(await screen.findByText(t("reports.reason.recipient_email_invalid"))).toBeTruthy();
  });

  it("offers CSV only with the right to export data, and says why not", async () => {
    open("/reports/new", "tester", addSales, {
      rolePermissions: {
        tester: (BUILT_IN_ROLE_PERMISSIONS.editor ?? []).filter((p) => p !== "data:export"),
      },
    });
    const csv = await screen.findByRole("radio", { name: "CSV" });
    expect(csv.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(t("reports.reason.csv_needs_export"))).toBeTruthy();
  });

  it("draws the preview of the draft and sends nothing", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [fakeReport("r1")];
    });
    const opened: Blob[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      opened.push(blob as Blob);
      return "blob:preview";
    });
    onTestFinished(() => create.mockRestore());
    await user.click(await screen.findByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview: Wochenbericht Vertrieb" });
    expect(await within(dialog).findByText("wochenbericht.pdf")).toBeTruthy();
    expect(within(dialog).getByText(/of 10 MB/)).toBeTruthy();
    expect(within(dialog).getByText(t("reports.preview.note"))).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Download" })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Open in a new tab" })).toBeTruthy();
    // The link's file is a PDF by type, so the new tab shows it.
    expect(opened.at(-1)?.type).toBe("application/pdf");
    expect(server.areas.reports.previews[0]).toMatchObject({ dashboardId: "d1" });
    expect(server.areas.reports.sent).toEqual([]);
  });

  it("shows whose rights a stored report runs with, and why it is suspended", async () => {
    open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [
        fakeReport("r1", {
          ownerId: "u7",
          ownerName: "Tim Berger",
          suspended: { code: "reports.creator_gone", message: "", since: 0 },
        }),
      ];
    });
    expect(
      await screen.findByText("Runs with the rights of Tim Berger; editing does not change that."),
    ).toBeTruthy();
    expect(screen.getByText(new RegExp(t("reports.reason.creator_gone")))).toBeTruthy();
  });

  it("loads the saved state when someone else changed the report meanwhile", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [fakeReport("r1")];
    });
    const name = await screen.findByLabelText("Name");
    const stored = server.areas.reports.reports[0];
    if (stored === undefined) throw new Error("no report");
    server.areas.reports.reports = [{ ...stored, name: "Von Grace geändert", version: 2 }];
    await user.type(name, " neu");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(t("reports.conflict"))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: t("reports.conflictLoad") }));
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Von Grace geändert"),
    );
  });

  it("saves after pausing in the editor without a conflict with itself", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [fakeReport("r1", { version: 4 })];
    });
    const name = await screen.findByLabelText("Name");
    await user.type(name, " neu");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByText(t("reports.pausedNote"))).toBeTruthy();
    // The draft is still there, and Save goes out with the version the pause answered.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Wochenbericht Vertrieb neu",
    );
    expect(server.areas.reports.paused).toEqual([{ id: "r1", paused: true, version: 4 }]);
    // Sending now reads nothing that would put the stored report over the draft.
    await user.click(screen.getByRole("button", { name: "Send now" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Send “Wochenbericht Vertrieb” now?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(server.areas.reports.sent).toEqual(["r1"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Wochenbericht Vertrieb neu",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.reports.saved).toHaveLength(1));
    expect(server.areas.reports.saved[0]).toMatchObject({
      name: "Wochenbericht Vertrieb neu",
      paused: true,
      version: 5,
    });
    expect(screen.queryByText(t("reports.conflict"))).toBeNull();
    // Saved: the editor starts over from what the server stored.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        "Wochenbericht Vertrieb neu",
      ),
    );
  });

  it("keeps the draft through pause and send", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [fakeReport("r1")];
    });
    await user.type(await screen.findByLabelText("Description"), "Entwurf");
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await screen.findByRole("button", { name: "Resume" });
    await user.click(screen.getByRole("button", { name: "Send now" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(server.areas.reports.sent).toEqual(["r1"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Nothing was saved, and what was typed is still in the form.
    expect(server.areas.reports.saved).toEqual([]);
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Entwurf");
    // The report itself was not read again: only the list, the runs and the status were.
    const reads = server.calls.filter(
      (call) => call.method === "GET" && call.path.endsWith("/reports/r1"),
    );
    expect(reads).toHaveLength(1);
  });

  it("clears the refused mark when the refused person is removed", async () => {
    const { user, server } = open("/reports/r1", "editor", (s) => {
      addSales(s);
      s.areas.reports.people.u3 = { name: "Alan Turing", email: "alan@example.com" };
      s.areas.reports.reports = [
        fakeReport("r1", {
          recipients: [
            { userId: "u3", email: "alan@example.com", name: "Alan Turing", external: false },
            { userId: "u1", email: "ada@example.com", name: "Ada Lovelace", external: false },
          ],
        }),
      ];
      s.areas.reports.refuse = {
        status: 422,
        code: "validation",
        field: "recipients",
        reason: "reports.recipient_no_access",
        params: { index: "0", name: "Alan Turing" },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Alan Turing cannot read the dashboard.");
    await user.click(screen.getByRole("button", { name: "Remove Alan Turing" }));
    // Ada moved into the first place; she is not marked, and the error is gone.
    expect(screen.queryByText("refused")).toBeNull();
    expect(screen.queryByText("Alan Turing cannot read the dashboard.")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Ada Lovelace" }).closest("li")?.className,
    ).not.toContain("report-chip--refused");
    // The next save goes out without the refused person.
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.reports.saved).toHaveLength(1));
    expect(server.areas.reports.saved[0]?.recipients).toEqual([{ userId: "u1" }]);
  });

  it("pauses a report someone else changed meanwhile, on the version the server has", async () => {
    const { user, server } = open("/reports", "editor", (s) => {
      s.areas.reports.reports = [fakeReport("r1", { version: 4 })];
    });
    const menu = await screen.findByRole("button", {
      name: "Actions for Wochenbericht Vertrieb",
    });
    const stored = server.areas.reports.reports[0];
    if (stored === undefined) throw new Error("no report");
    server.areas.reports.reports = [{ ...stored, version: 6 }];
    await user.click(menu);
    await user.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() =>
      expect(server.areas.reports.paused).toEqual([{ id: "r1", paused: true, version: 6 }]),
    );
    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("offers no copy while the organization has as many reports as it may", async () => {
    const { user } = open("/reports", "editor", (s) => {
      s.areas.reports.status = {
        ...FAKE_REPORTS_ON,
        limits: { ...FAKE_REPORTS_ON.limits, maxReportsPerOrg: 1 },
      };
      s.areas.reports.reports = [fakeReport("r1")];
    });
    expect(await screen.findByText(t("reports.reason.too_many", { max: 1 }))).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Actions for Wochenbericht Vertrieb" }));
    const copy = await screen.findByRole("menuitem", { name: "Duplicate" });
    expect(copy.getAttribute("aria-disabled") ?? String((copy as HTMLButtonElement).disabled)).toBe(
      "true",
    );
  });

  it("pauses from the row menu with the stored version, and deletes after asking", async () => {
    const { user, server } = open("/reports", "editor", (s) => {
      s.areas.reports.reports = [fakeReport("r1", { version: 4 })];
    });
    await user.click(
      await screen.findByRole("button", { name: "Actions for Wochenbericht Vertrieb" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Pause" }));
    await waitFor(() =>
      expect(server.areas.reports.paused).toEqual([{ id: "r1", paused: true, version: 4 }]),
    );
    expect(await screen.findByText("paused")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Actions for Wochenbericht Vertrieb" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete “Wochenbericht Vertrieb”?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.areas.reports.reports).toEqual([]));
    expect(await screen.findByRole("heading", { name: t("reports.empty.title") })).toBeTruthy();
  });

  it("shows the runs with their results and reasons, and sends now after asking", async () => {
    const { user, server } = open("/reports/r1/runs", "editor", (s) => {
      s.areas.reports.reports = [fakeReport("r1")];
      s.areas.reports.runs.r1 = [
        fakeRun("x3", {
          status: "failed",
          attempt: 2,
          sent: 0,
          attachmentBytes: null,
          error: { code: "reports.attachment_too_large", message: "" },
        }),
        fakeRun("x2", { status: "partial", sent: 2, skippedRecipients: 1, csvWithheld: 1 }),
        fakeRun("x1"),
      ];
    });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("failed")).toBeTruthy();
    expect(within(table).getByText(t("reports.reason.attachment_too_large"))).toBeTruthy();
    expect(within(table).getByText("Second attempt")).toBeTruthy();
    expect(within(table).getByText("2 of 3")).toBeTruthy();
    expect(within(table).getByText("1 skipped")).toBeTruthy();
    expect(within(table).getByText("1 PDF only")).toBeTruthy();
    expect(within(table).getAllByText("214 kB").length).toBe(2);
    expect(screen.getByText(t("reports.runs.footer", { days: 90 }))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Send now" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Send “Wochenbericht Vertrieb” now?",
    });
    // Focus starts on Cancel, so Enter does not send.
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(within(dialog).getByText(/all recipients \(1\)/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(server.areas.reports.sent).toEqual(["r1"]));
    expect(await within(await screen.findByRole("table")).findByText("waiting")).toBeTruthy();
  });

  it("does not offer sending without a mail server", async () => {
    open("/reports/r1/runs", "editor", (s) => {
      s.areas.reports.status = { ...FAKE_REPORTS_ON, mailConfigured: false };
      s.areas.reports.reports = [fakeReport("r1")];
    });
    const send = await screen.findByRole("button", { name: "Send now" });
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() =>
      expect(
        document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toBe(t("reports.reason.mail_not_configured")),
    );
    expect(await screen.findByText(/^No run yet\. The next one: /)).toBeTruthy();
  });

  it("starts a report from a dashboard with the range and values chosen there", async () => {
    const { user, location } = open("/dashboards/d1", "editor", (s) => {
      addSales(s);
      s.areas.reports.reports = [fakeReport("r1"), fakeReport("r2", { dashboardId: "d9" })];
    });
    await user.click(await screen.findByRole("button", { name: t("toolbar.more") }));
    expect(
      await screen.findByRole("menuitem", { name: "Reports of this dashboard: 1" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Create report…" }));
    await waitFor(() => expect(location().pathname).toBe("/reports/new"));
    expect(location().search).toMatchObject({ dashboard: "d1", from: "now-6h", to: "now" });
    // The editor opens on that dashboard.
    await waitFor(() =>
      expect(screen.getByLabelText("Dashboard").textContent).toContain("Verkauf Überblick"),
    );
  });

  it("offers a dashboard no report entries while reports are off", async () => {
    const { user } = open("/dashboards/d1", "editor", (s) => {
      addSales(s);
      s.areas.reports.status = { ...FAKE_REPORTS_ON, enabled: false };
    });
    await user.click(await screen.findByRole("button", { name: t("toolbar.more") }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: "Create report…" })).toBeNull();
  });
});
