import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/i18n";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { PG_ID } from "../datasources/test/fakeDatasources";
import type { BadgeRule, HistoryEntry, Rule } from "./api";
import { alertLimits, badgeState } from "./PanelAlerts";
import { evalErrorText } from "./reasons";
import {
  conditionText,
  draftFromPanel,
  draftFromRule,
  emptyDraft,
  forChoices,
  inputOf,
  labelNameValid,
  panelChanged,
  parseNumber,
  type RuleDraft,
  rangeSecsOf,
  reduceText,
  sortRules,
  timelineRows,
  validateDraft,
  withInterval,
} from "./ruleModel";
import { FAKE_STATUS_ON } from "./test/fakeAlerting";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params ?? {});
const BOUNDS = { minIntervalSecs: 30, maxContactPointsPerRule: 5 };

function filled(patch: Partial<RuleDraft> = {}): RuleDraft {
  return {
    ...emptyDraft(),
    name: "Lager-API Latenz p95",
    datasourceId: PG_ID,
    query: { sql: "SELECT 1" },
    value: "1,5",
    ...patch,
  };
}

const RULE: Rule = {
  id: "r1",
  name: "Lager-API Latenz p95",
  description: "",
  runbookUrl: null,
  datasourceId: PG_ID,
  query: { query: { sql: "SELECT ts AS time, latency FROM api" }, steps: [], variables: {} },
  queryHidden: false,
  rangeSecs: 600,
  reduce: { shape: "frame", function: "max" },
  condition: { op: "gt", value: 1.5 },
  intervalSecs: 60,
  forSecs: 300,
  noDataState: "no_data",
  errorState: "error",
  labels: { team: "lager" },
  reminderSecs: 14_400,
  paused: false,
  contactPointIds: ["cp1"],
  dashboardId: null,
  panelId: null,
  version: 3,
  createdBy: "u1",
  createdAt: 0,
  updatedBy: "u1",
  updatedByName: "Ada Lovelace",
  updatedAt: 0,
  lastEvaluatedAt: null,
  lastDurationMs: null,
  lastError: null,
  skippedEvaluations: 0,
  state: "firing",
  instanceCounts: { firing: 1, ok: 2 },
};

describe("rule editor logic", () => {
  it("turns a filled draft into the documented request body", () => {
    const draft = filled({
      labels: [
        { key: "team", value: "lager" },
        { key: "", value: "" },
      ],
      runbookUrl: " https://wiki.example/lager ",
      contactPointIds: ["cp1"],
    });
    expect(validateDraft(draft, BOUNDS)).toEqual({});
    expect(inputOf(draft)).toEqual({
      name: "Lager-API Latenz p95",
      description: "",
      runbookUrl: "https://wiki.example/lager",
      datasourceId: PG_ID,
      query: { query: { sql: "SELECT 1" }, steps: [], variables: {} },
      rangeSecs: 600,
      reduce: { shape: "frame", function: "last" },
      condition: { op: "gt", value: 1.5 },
      intervalSecs: 60,
      forSecs: 0,
      noDataState: "no_data",
      errorState: "error",
      labels: { team: "lager" },
      reminderSecs: 14_400,
      contactPointIds: ["cp1"],
      dashboardId: null,
      panelId: null,
    });
  });

  it("builds the reduce step per shape", () => {
    expect(inputOf(filled({ shape: "documents", documentsMode: "count" })).reduce).toEqual({
      shape: "documents",
      mode: "count",
    });
    expect(
      inputOf(
        filled({
          shape: "documents",
          documentsMode: "field",
          documentsPath: "$.queue.depth",
          documentsFunction: "max",
        }),
      ).reduce,
    ).toEqual({ shape: "documents", mode: "field", path: "$.queue.depth", function: "max" });
    expect(
      inputOf(filled({ shape: "graph", graphCount: "nodes", graphLabel: "Dienst" })).reduce,
    ).toEqual({
      shape: "graph",
      count: "nodes",
      label: "Dienst",
    });
    expect(inputOf(filled({ shape: "graph", graphCount: "paths" })).reduce).toEqual({
      shape: "graph",
      count: "paths",
    });
  });

  it("names every problem at its field", () => {
    const errors = validateDraft(
      {
        ...emptyDraft(),
        shape: "documents",
        documentsMode: "field",
        documentsPath: "queue.depth",
        op: "outside",
        low: "20",
        high: "10",
        intervalSecs: 60,
        forSecs: 90,
        labels: [
          { key: "alertname", value: "x" },
          { key: "team", value: "a" },
        ],
        contactPointIds: ["1", "2", "3", "4", "5", "6"],
        runbookUrl: "ftp://wiki",
      },
      BOUNDS,
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        "contactPointIds",
        "datasourceId",
        "documentsPath",
        "forSecs",
        "high",
        "labels",
        "name",
        "runbookUrl",
      ].sort(),
    );
    expect(validateDraft(filled({ intervalSecs: 10 }), BOUNDS).intervalSecs?.params).toEqual({
      min: 30,
    });
    expect(validateDraft(filled({ value: "zwei" }), BOUNDS).value?.key).toBe(
      "alerting.editor.error.number",
    );
    expect(validateDraft(filled({ query: { sql: "  " } }), BOUNDS).query).toBeDefined();
  });

  it("reads numbers with a comma or a point and checks label names as the server does", () => {
    expect(parseNumber("1,5")).toBe(1.5);
    expect(parseNumber("-2.25")).toBe(-2.25);
    expect(parseNumber("1e3")).toBe(1000);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("12 s")).toBeNull();
    expect(labelNameValid("team")).toBe(true);
    expect(labelNameValid("_x1")).toBe(true);
    expect(labelNameValid("1team")).toBe(false);
    expect(labelNameValid("alertname")).toBe(false);
    expect(labelNameValid("__name")).toBe(false);
  });

  it("keeps the for-duration a multiple of the interval", () => {
    const draft = filled({ intervalSecs: 60, forSecs: 300 });
    expect(withInterval(draft, 120).forSecs).toBe(360);
    expect(withInterval({ ...draft, forSecs: 0 }, 120).forSecs).toBe(0);
    expect(forChoices(120, 360)).toContain(360);
    expect(forChoices(120, 0).every((secs) => secs % 120 === 0)).toBe(true);
  });

  it("reads a stored rule back into the same body", () => {
    const draft = draftFromRule(RULE);
    expect(draft.value).toBe("1.5");
    expect(draft.frameFunction).toBe("max");
    const input = inputOf(draft);
    expect(input.condition).toEqual(RULE.condition);
    expect(input.reduce).toEqual(RULE.reduce);
    expect(input.labels).toEqual(RULE.labels);
    expect(input.query).toEqual(RULE.query);
  });

  it("copies a panel's query, its variables and range, and sees when the panel changed", () => {
    const panel = {
      dashboardId: "d1",
      panelId: "p1",
      title: "API-Latenz",
      dashboardTitle: "Lager",
      timeFrom: "now-6h",
      target: { datasourceId: PG_ID, query: { sql: "SELECT 1" } },
      variables: [
        { name: "region", type: "query", current: "Nord" },
        { name: "env", type: "custom", current: { value: ["a", "b"] } },
        { name: "fixed", type: "constant", current: "x" },
      ],
    };
    const draft = draftFromPanel(panel);
    expect(draft.name).toBe("API-Latenz");
    expect(draft.rangeSecs).toBe(21_600);
    expect(draft.variables).toEqual({ region: "Nord", env: ["a", "b"] });
    expect(draft.dashboardId).toBe("d1");
    expect(inputOf(filled({ ...draft, value: "1" })).panelId).toBe("p1");
    expect(panelChanged(draft, panel)).toBe(false);
    expect(
      panelChanged(draft, {
        ...panel,
        target: { datasourceId: PG_ID, query: { sql: "SELECT 2" } },
      }),
    ).toBe(true);
    expect(rangeSecsOf("now-1d")).toBe(86_400);
    expect(rangeSecsOf("2026-01-01")).toBe(600);
  });

  it("writes conditions, reduce steps and evaluation errors in words", () => {
    expect(conditionText(t, { op: "gte", value: 1.5 }, "de")).toBe("≥ 1,5");
    expect(conditionText(t, { op: "outside", low: 10, high: 20 }, "en")).toBe("outside 10 to 20");
    expect(reduceText(t, { shape: "frame", function: "max" })).toBe("max per series");
    expect(reduceText(t, { shape: "graph", count: "paths" })).toBe("Number of paths");
    expect(
      evalErrorText(t, {
        code: "alerting.not_a_number",
        params: { field: "$.depth", found: "text" },
      }),
    ).toBe("Field $.depth holds text, not a number.");
    expect(
      evalErrorText(t, { code: "alerting.truncated", params: { reason: "graph.node_limit" } }),
    ).toBe("The source cut the result (node limit), so the count is not certain.");
    // An unknown code never shows the server's own words.
    expect(evalErrorText(t, { code: "alerting.something_new", params: {} })).toBe(
      "The evaluation failed.",
    );
  });

  it("sorts rules by state, paused last, then by name", () => {
    const sorted = sortRules([
      { name: "b", state: "ok", paused: false },
      { name: "a", state: "ok", paused: true },
      { name: "c", state: "firing", paused: false },
      { name: "a", state: "pending", paused: false },
      { name: "z", state: null, paused: false },
    ]);
    expect(sorted.map((rule) => `${rule.name}:${rule.state}`)).toEqual([
      "c:firing",
      "a:pending",
      "b:ok",
      "z:null",
      "a:ok",
    ]);
  });

  it("draws an instance's states over the range from its changes", () => {
    const entry = (at: number, from: HistoryEntry["fromState"], to: HistoryEntry["toState"]) =>
      ({
        id: String(at),
        ruleId: "r1",
        ruleName: "R",
        fingerprint: "f1",
        labels: { instance: "a" },
        kind: "transition",
        fromState: from,
        toState: to,
        value: null,
        error: null,
        silenceId: null,
        contactPointId: null,
        event: null,
        attempt: null,
        result: null,
        at,
      }) as HistoryEntry;
    const rows = timelineRows([entry(30, "pending", "firing"), entry(10, "ok", "pending")], 0, 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("R · a");
    expect(rows[0]?.segments).toEqual([
      { state: "ok", from: 0, to: 10 },
      { state: "pending", from: 10, to: 30 },
      { state: "firing", from: 30, to: 100 },
    ]);
  });
});

const BADGE: BadgeRule = {
  id: "r1",
  name: "Lager-API Latenz p95",
  state: "firing",
  paused: false,
  condition: { op: "gt", value: 1.5 },
  frame: true,
  silenced: false,
};

describe("panel badge", () => {
  it("ranks the panel's rules as the board does and takes the limits of frame rules", () => {
    const RULE = BADGE;
    expect(badgeState([])).toBeNull();
    expect(badgeState([{ ...RULE, state: "ok" }])).toBe("ok");
    expect(
      badgeState([
        { ...RULE, state: "pending" },
        { ...RULE, state: "error" },
        { ...RULE, state: "firing", paused: true },
      ]),
    ).toBe("error");
    expect(
      badgeState([
        { ...RULE, state: "no_data" },
        { ...RULE, state: "firing" },
      ]),
    ).toBe("firing");
    // Firing but silenced reads "Stumm", below pending.
    expect(badgeState([{ ...RULE, silenced: true }])).toBe("silenced");
    expect(
      badgeState([
        { ...RULE, silenced: true },
        { ...RULE, state: "pending" },
      ]),
    ).toBe("pending");
    expect(
      alertLimits([
        RULE,
        { ...RULE, condition: { op: "outside", low: 1, high: 2 } },
        { ...RULE, frame: false },
        { ...RULE, paused: true },
      ]),
    ).toEqual([1.5, 1, 2]);
  });
});

function open(
  path: string,
  role: string,
  setup?: (server: ReturnType<typeof installFakeServer>) => void,
) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "MouseWerk", role }] },
  });
  server.areas.alerting.status = { ...FAKE_STATUS_ON };
  setup?.(server);
  return { server, ...renderApp(path) };
}

describe("Alerting pages", () => {
  it("shows the entry with the number of firing rules, and the rules with their instances", async () => {
    const { user, server } = open("/alerting", "editor", (s) => {
      s.areas.alerting.rules = [RULE as unknown as Record<string, unknown>];
      s.areas.alerting.instances = {
        r1: [
          {
            fingerprint: "f1",
            labels: { instance: "lager-api-1" },
            state: "firing",
            stateSince: Date.now() - 60_000,
            pendingSince: null,
            lastEvaluatedAt: Date.now(),
            lastValue: 1.84,
            lastError: null,
            lastNotifiedAt: null,
            lastNotifiedState: null,
            silencedBy: [],
          },
        ],
      };
    });
    const nav = await screen.findByRole("navigation", { name: t("nav.label") });
    const entry = await within(nav).findByRole("link", { name: /Alerting/ });
    expect(await within(entry).findByText("1 rule firing")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Lager-API Latenz p95" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /New rule/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Instances of “Lager-API Latenz p95”" }));
    const list = await screen.findByRole("list", { name: "Instances of “Lager-API Latenz p95”" });
    expect(within(list).getByText("instance=lager-api-1")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Silence instance=lager-api-1" })).toBeTruthy();
    expect(server.calls.some((call) => call.path.endsWith("/alerting/rules/r1"))).toBe(true);
  });

  it("shows viewers the rules without the actions that change them", async () => {
    open("/alerting", "viewer", (s) => {
      s.areas.alerting.rules = [RULE as unknown as Record<string, unknown>];
    });
    expect(await screen.findByRole("link", { name: "Lager-API Latenz p95" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /New rule/ })).toBeNull();
    expect(screen.getByText(t("alerting.rules.footerReadOnly"))).toBeTruthy();
  });

  it("has no entry while alerting is off", async () => {
    const { server } = open("/", "owner", (s) => {
      s.areas.alerting.status = { ...FAKE_STATUS_ON, enabled: false, orgEnabled: false };
    });
    const nav = await screen.findByRole("navigation", { name: t("nav.label") });
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/alerting/status"))).toBe(true),
    );
    expect(within(nav).queryByRole("link", { name: /Alerting/ })).toBeNull();
  });

  it("lets an admin add a webhook and shows its secret once", async () => {
    const { user, server } = open("/alerting/contact-points", "admin");
    await user.click(await screen.findByRole("button", { name: "Contact point" }));
    const dialog = await screen.findByRole("dialog", { name: "New contact point" });
    await user.click(within(dialog).getByRole("radio", { name: "Webhook" }));
    await user.type(within(dialog).getByLabelText("Name"), "Lager-Webhook");
    await user.type(within(dialog).getByLabelText("URL"), "https://hooks.lager.test/kalzit");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const secret = await screen.findByRole("dialog", { name: "Secret of “Lager-Webhook”" });
    expect(within(secret).getByText("ab".repeat(32))).toBeTruthy();
    await user.click(within(secret).getByRole("button", { name: "I have stored it" }));
    expect(await screen.findByText("hooks.lager.test")).toBeTruthy();
    expect(server.areas.alerting.contactPoints).toHaveLength(1);
  });

  it("shows contact points read-only to editors", async () => {
    open("/alerting/contact-points", "editor", (s) => {
      s.areas.alerting.contactPoints = [
        {
          id: "cp1",
          name: "Bereitschaft Lager",
          kind: "mail",
          language: "de",
          recipients: ["bereitschaft@mousewerk.test", "j.berger@mousewerk.test"],
          lastDelivery: null,
          rules: 3,
          version: 1,
          updatedAt: 0,
        },
      ];
    });
    expect(await screen.findByText("Bereitschaft Lager")).toBeTruthy();
    expect(screen.getByText(t("alerting.contact.readOnly"))).toBeTruthy();
    expect(screen.getByText("2 recipients · German")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Contact point" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("checks the rule before saving and sends it once it is complete", async () => {
    const { user, server } = open("/alerting/rules/new", "editor", (s) => {
      s.areas.alerting.sources = [{ datasourceId: PG_ID, name: "Sales DB", kind: "postgres" }];
    });
    const save = await screen.findByRole("button", { name: "Save" });
    await user.click(save);
    expect(await screen.findByText(t("alerting.editor.error.nameRequired"))).toBeTruthy();
    expect(screen.getByText(t("alerting.editor.error.sourceRequired"))).toBeTruthy();
    expect(server.areas.alerting.saved).toHaveLength(0);

    await user.type(screen.getByLabelText("Name"), "Umsatz unter Plan");
    await user.click(screen.getByLabelText("Data source"));
    await user.click(await screen.findByRole("option", { name: "Sales DB" }));
    const query = await screen.findByRole("textbox", { name: "Query" });
    await user.click(query);
    await user.keyboard("SELECT 1");
    await user.type(screen.getByLabelText("Threshold"), "1000");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.alerting.saved).toHaveLength(1));
    expect(server.areas.alerting.saved[0]).toMatchObject({
      name: "Umsatz unter Plan",
      datasourceId: PG_ID,
      condition: { op: "gt", value: 1000 },
      reduce: { shape: "frame", function: "last" },
    });
  });

  it("shows a newer saved version instead of overwriting it", async () => {
    const { user, server } = open("/alerting/rules/r1", "editor", (s) => {
      s.areas.alerting.rules = [RULE as unknown as Record<string, unknown>];
      s.areas.alerting.sources = [{ datasourceId: PG_ID, name: "Sales DB", kind: "postgres" }];
    });
    await screen.findByDisplayValue("Lager-API Latenz p95");
    // Someone else saves meanwhile.
    server.areas.alerting.rules[0] = { ...RULE, version: 4, updatedByName: "Lea Hoffmann" };
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Lea Hoffmann, version 4/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save mine anyway" }));
    await waitFor(() => expect(server.areas.alerting.rules[0]?.version).toBe(5));
  });

  it("says when the server has no preview yet", async () => {
    const { user } = open("/alerting/rules/r1", "editor", (s) => {
      s.areas.alerting.rules = [RULE as unknown as Record<string, unknown>];
      s.areas.alerting.sources = [{ datasourceId: PG_ID, name: "Sales DB", kind: "postgres" }];
    });
    await user.click(await screen.findByRole("button", { name: "Evaluate now" }));
    expect(await screen.findByText(t("alerting.preview.missing"))).toBeTruthy();
  });

  it("shows the preview's instances with their state", async () => {
    const { user } = open("/alerting/rules/r1", "editor", (s) => {
      s.areas.alerting.rules = [RULE as unknown as Record<string, unknown>];
      s.areas.alerting.sources = [{ datasourceId: PG_ID, name: "Sales DB", kind: "postgres" }];
      s.areas.alerting.preview = {
        evaluatedAt: Date.now(),
        datasourceOptedIn: true,
        shape: "frame",
        queryError: null,
        error: null,
        truncated: null,
        series: [
          { labels: { instance: "lager-api-1" }, field: "p95", value: 1.84, conditionMet: true },
          { labels: { instance: "lager-api-3" }, field: "p95", value: 0.41, conditionMet: false },
        ],
        valueFields: ["p95"],
        labelFields: ["instance"],
        skippedDocuments: 0,
        instances: [
          {
            labels: { instance: "lager-api-1" },
            state: "pending",
            pendingTarget: "firing",
            value: 1.84,
          },
          { labels: { instance: "lager-api-3" }, state: "ok", value: 0.41 },
        ],
        message: {
          subject: "[Firing] Lager-API Latenz p95 · MouseWerk",
          text: "instance=lager-api-1: max = 1.84",
          webhook: { version: 1 },
        },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Evaluate now" }));
    expect(await screen.findByText("2 series")).toBeTruthy();
    expect(screen.getByText("instance=lager-api-1")).toBeTruthy();
    expect(screen.getByText("becomes Firing after the “for” duration")).toBeTruthy();
    expect(screen.getByText(/Result now: 1 Pending, 1 OK\./)).toBeTruthy();
    expect(screen.getByText("[Firing] Lager-API Latenz p95 · MouseWerk")).toBeTruthy();
  });

  it("shows the badge on the panel a rule was made from and offers to create one", async () => {
    const { user } = open("/dashboards/d1", "editor", (s) => {
      const model = emptyModel("Lager");
      model.panels.push({
        id: "p1",
        type: "stat",
        title: "API-Latenz",
        grid: { x: 0, y: 0, w: 12, h: 8 },
        targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1 AS v" } }],
        transformations: [],
        options: {},
        fieldConfig: {},
      });
      addDashboard(s.areas.dashboards, "d1", model);
      s.areas.alerting.rules = [
        { ...RULE, dashboardId: "d1", panelId: "p1" } as unknown as Record<string, unknown>,
      ];
    });
    const badge = await screen.findByRole("button", { name: "Alert: 1 rule firing" });
    await user.click(badge);
    const dialog = await screen.findByRole("dialog", { name: "Alert rules on “API-Latenz”" });
    expect(within(dialog).getByText("Lager-API Latenz p95")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Open rule" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /API-Latenz/, expanded: false }));
    expect(
      await screen.findByRole("menuitem", { name: "Create alert rule from “API-Latenz”" }),
    ).toBeTruthy();
  });

  it("silences an instance with a comment", async () => {
    const { user, server } = open("/alerting/silences?create=true", "editor");
    const dialog = await screen.findByRole("dialog", { name: "Silence" });
    await user.type(within(dialog).getByLabelText("Label of condition 1"), "team");
    await user.type(within(dialog).getByLabelText("Value of condition 1"), "lager");
    await user.click(within(dialog).getByRole("button", { name: "Silence" }));
    expect(
      await within(dialog).findByText(t("alerting.reason.alerts.comment_required")),
    ).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Comment (required)"), "Umzug");
    await user.click(within(dialog).getByRole("button", { name: "Silence" }));
    await waitFor(() => expect(server.areas.alerting.silences).toHaveLength(1));
    expect(server.areas.alerting.silences[0]).toMatchObject({
      matchers: [{ label: "team", op: "=", value: "lager" }],
      comment: "Umzug",
    });
    expect(await screen.findByText("team=lager")).toBeTruthy();
  });
});
