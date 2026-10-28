import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseEventStream } from "../../api/client";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { nextAnnouncement } from "./AiAnswer";
import { aiLimitReason } from "./calls";
import { aiEvents } from "./test/fakeAiAdmin";

const USABLE = {
  enabled: true,
  usable: true,
  orgProvidersAllowed: true,
  noticeAcknowledged: true,
  provider: {
    id: "p1",
    name: "Lokal",
    kind: "openai",
    model: "modell-1",
    host: "llm.intern",
    scope: "server",
    endpoint: "llm.intern:11434",
    leavesNetwork: false,
    noticeAcknowledged: true,
  },
  usage: {
    requests: 3,
    tokens: 500,
    requestsLimit: 200,
    tokensLimit: 0,
    orgTokensMonth: 0,
    orgTokensMonthLimit: 0,
  },
  maxRowsToModel: 200,
};

function open(status: Record<string, unknown> | null) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  if (status !== null) {
    server.areas.aiAdmin.status = status;
  }
  return { server, ...renderApp("/explore") };
}

async function typeSql(sql: string) {
  const editor = await screen.findByRole("textbox", { name: "Query" });
  fireEvent.change(editor, { target: { value: sql } });
  return editor;
}

describe("AI calls: parts", () => {
  it("reads server-sent events across chunks and skips keep-alives", () => {
    const first = parseEventStream(
      'event: meta\ndata: {"a":1}\n\n: keep-alive\n\nevent: text\ndata: {"te',
    );
    expect(first.events).toEqual([{ event: "meta", data: { a: 1 } }]);
    const second = parseEventStream(`${first.rest}xt":"Hallo"}\r\n\r\n`);
    expect(second.events).toEqual([{ event: "text", data: { text: "Hallo" } }]);
    expect(second.rest).toBe("");
  });

  it("announces every finished sentence once, and the rest when the answer is whole", () => {
    expect(nextAnnouncement("Die Abfrage summiert", 0, false)).toEqual({ say: "", upTo: 0 });
    const text = "Erster Satz. Zweiter Satz. Und ein dritter";
    const first = nextAnnouncement(text, 0, false);
    expect(first).toEqual({ say: "Erster Satz. Zweiter Satz.", upTo: 26 });
    expect(nextAnnouncement(text, first.upTo, false).say).toBe("");
    expect(nextAnnouncement(`${text} Satz! Noch`, first.upTo, false).say).toBe(
      "Und ein dritter Satz!",
    );
    expect(nextAnnouncement(text, first.upTo, true)).toEqual({
      say: "Und ein dritter",
      upTo: text.length,
    });
  });

  it("knows a used-up limit from the status", () => {
    expect(aiLimitReason(undefined)).toBeUndefined();
    const usage = { ...USABLE.usage, requests: 200 };
    expect(aiLimitReason({ ...USABLE, usage })).toEqual({
      reason: "ai.limit_user_requests",
      params: { max: "200" },
    });
    expect(
      aiLimitReason({
        ...USABLE,
        usage: { ...USABLE.usage, orgTokensMonth: 9, orgTokensMonthLimit: 9 },
      })?.reason,
    ).toBe("ai.limit_org_tokens");
  });
});

describe("AI in Explore", () => {
  it("shows nothing of AI while it is off", async () => {
    const { server } = open(null);
    await typeSql("SELECT 1");
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/ai/status"))).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Explain" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Draft" })).toBeNull();
  });

  it("asks for the notice first, then streams the explanation", async () => {
    const { server, user } = open({
      ...USABLE,
      noticeAcknowledged: false,
      noticeText: "Fragen an den DSB.",
    });
    await typeSql("SELECT region, sum(betrag) FROM bestellungen GROUP BY region");
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    const notice = await screen.findByRole("dialog", { name: "Before you use AI" });
    expect(within(notice).getByText(/the query text goes to Lokal \(llm\.intern\)/)).toBeTruthy();
    expect(within(notice).getByText("Fragen an den DSB.")).toBeTruthy();
    expect(server.areas.aiAdmin.calls).toHaveLength(0);
    await user.click(within(notice).getByRole("button", { name: "Got it" }));

    const answer = await screen.findByRole("region", { name: "Explanation" });
    expect(
      await within(answer).findAllByText("Die Abfrage summiert den Umsatz je Region."),
    ).toBeTruthy();
    expect(within(answer).getByText("Lokal · modell-1")).toBeTruthy();
    expect(within(answer).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(server.calls.some((call) => call.path.endsWith("/ai/notice"))).toBe(true);
    expect(server.areas.aiAdmin.calls[0]).toEqual({
      path: "/api/orgs/o1/ai/explain",
      body: {
        datasourceId: PG_ID,
        query: { sql: "SELECT region, sum(betrag) FROM bestellungen GROUP BY region" },
        language: "en",
      },
    });
  });

  it("offers a draft without running it, and applies it to the editor", async () => {
    const { server, user } = open(USABLE);
    server.areas.aiAdmin.callAnswer = {
      events: aiEvents(
        "```sql\nSELECT count(*) FROM kunden\n```",
        { schema: false },
        { draft: { sql: "SELECT count(*) FROM kunden" }, draftText: "SELECT count(*) FROM kunden" },
      ),
    };
    const editor = await typeSql("SELECT 1");
    const runsBefore = server.areas.datasources.queries.length;
    await user.click(await screen.findByRole("button", { name: "Draft" }));
    await user.type(
      screen.getByRole("textbox", { name: "What should the query return?" }),
      "Kunden zählen",
    );
    await user.click(screen.getByRole("button", { name: "Write draft" }));
    const draft = await screen.findByRole("region", { name: "Draft" });
    expect(await within(draft).findByText(/Not run yet/)).toBeTruthy();
    expect(within(draft).getByText(/no schema went along/)).toBeTruthy();
    expect(server.areas.aiAdmin.calls[0]?.body).toMatchObject({
      request: "Kunden zählen",
      query: { sql: "SELECT 1" },
    });
    await user.click(within(draft).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toBe("SELECT count(*) FROM kunden"),
    );
    expect(screen.queryByRole("region", { name: "Draft" })).toBeNull();
    expect(server.areas.datasources.queries.length).toBe(runsBefore);
  });

  it("reads the answer out from outside the busy card, the last sentence too", async () => {
    const { server, user } = open(USABLE);
    server.areas.aiAdmin.callAnswer = { events: aiEvents("Erster Satz. Zweiter ohne Punkt") };
    await typeSql("SELECT 1");
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    const answer = await screen.findByRole("region", { name: "Explanation" });
    await within(answer).findByRole("button", { name: "Copy" });
    const live = answer.parentElement?.querySelector("[aria-live=polite]");
    expect(live).toBeTruthy();
    expect(answer.contains(live as Node)).toBe(false);
    expect(live?.closest("[aria-busy]")).toBeNull();
    // Whatever arrived together is read together; the unpunctuated end is read at the end.
    await waitFor(() => expect(live?.textContent).toMatch(/Zweiter ohne Punkt$/));
  });

  it("disables the buttons with the reason when the daily limit is used up", async () => {
    open({ ...USABLE, usage: { ...USABLE.usage, requests: 200 } });
    await typeSql("SELECT 1");
    const explain = await screen.findByRole("button", { name: "Explain" });
    expect(explain).toHaveProperty("disabled", true);
    const reason = document.getElementById(explain.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/You used your 200 AI calls for today/);
  });

  it("shows a refusal of the provider as an error to try again", async () => {
    const { server, user } = open(USABLE);
    server.areas.aiAdmin.callAnswer = {
      refusal: { status: 504, code: "ai_provider_error", reason: "ai.provider_timeout" },
    };
    await typeSql("SELECT 1");
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    const answer = await screen.findByRole("region", { name: "Explanation" });
    expect(await within(answer).findByText("The AI provider did not answer in time.")).toBeTruthy();
    expect(within(answer).getByText("Your query is unchanged.")).toBeTruthy();
    server.areas.aiAdmin.callAnswer = { events: aiEvents("Jetzt klappt es.") };
    await user.click(within(answer).getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByText("Jetzt klappt es.")).toBeTruthy();
  });

  it("stops a running call with Escape", async () => {
    const { server, user } = open(USABLE);
    server.areas.aiAdmin.callAnswer = {
      events: aiEvents("Ein Satz.").slice(0, 2),
      hang: true,
    };
    await typeSql("SELECT 1");
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    const answer = await screen.findByRole("region", { name: "Explanation" });
    const stop = await within(answer).findByRole("button", { name: "Stop" });
    stop.focus();
    await user.keyboard("{Escape}");
    expect(await within(answer).findByText("stopped")).toBeTruthy();
  });

  it("keeps Summarize off for a source closed to AI, with the reason", async () => {
    const { user } = open(USABLE);
    await typeSql("SELECT * FROM customers");
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("Grace")).toBeTruthy();
    const closed = await screen.findByRole("button", { name: "Summarize" });
    expect(closed).toHaveProperty("disabled", true);
    const reason = document.getElementById(closed.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/AI may not read/);
  });

  it("summarizes the result of a source open to AI and says what was sent", async () => {
    const { server, user } = open(USABLE);
    server.areas.aiAdmin.access[PG_ID] = { readable: true, excludedFields: [] };
    server.areas.aiAdmin.callAnswer = {
      events: aiEvents("Drei Kunden.", {
        results: [{ refId: "A", rows: 2, truncated: true, excludedValues: 1 }],
      }),
    };
    await typeSql("SELECT * FROM customers");
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("Grace")).toBeTruthy();
    const summarize = await screen.findByRole("button", { name: "Summarize" });
    await waitFor(() => expect(summarize).toHaveProperty("disabled", false));
    await user.click(summarize);
    const card = await screen.findByRole("region", { name: "Summary of the result" });
    expect(await within(card).findAllByText("Drei Kunden.")).toBeTruthy();
    expect(
      within(card).getByText(/Sent: query A and 2 rows to Lokal \(llm\.intern\)/),
    ).toBeTruthy();
    expect(within(card).getByText(/cut to the row limit/)).toBeTruthy();
    expect(server.areas.aiAdmin.calls.at(-1)?.body).toMatchObject({
      query: { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM customers" } },
      language: "en",
    });
  });
});

describe("AI on dashboards", () => {
  function dashboard(status: Record<string, unknown> | null) {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "viewer" }],
      },
    });
    if (status !== null) {
      server.areas.aiAdmin.status = status;
    }
    addDashboard(server.areas.dashboards, "d-sales", {
      ...emptyModel("Sales"),
      panels: [
        {
          id: "p-orders",
          type: "table",
          title: "Orders",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    });
    return { server, ...renderApp("/dashboards/d-sales") };
  }

  it("has no Summarize in the panel menu while AI is off", async () => {
    const { user } = dashboard(null);
    const panel = await screen.findByRole("article", { name: "Orders" });
    await user.click(within(panel).getByRole("button", { name: "Panel menu of “Orders”" }));
    expect(await screen.findByRole("menuitem", { name: /Inspect/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Summarize “Orders”" })).toBeNull();
  });

  it("lets a viewer summarize a panel through its stored queries", async () => {
    const { server, user } = dashboard(USABLE);
    server.areas.aiAdmin.callAnswer = {
      events: aiEvents("Die Bestellungen steigen.", {
        title: true,
        results: [{ refId: "A", rows: 3, truncated: false, excludedValues: 0 }],
      }),
    };
    const panel = await screen.findByRole("article", { name: "Orders" });
    await user.click(within(panel).getByRole("button", { name: "Panel menu of “Orders”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Summarize “Orders”" }));
    const dialog = await screen.findByRole("dialog", { name: "Summary: Orders" });
    expect(
      (await within(dialog).findAllByText("Die Bestellungen steigen.")).length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Sent: title, query A and 3 rows to Lokal/)).toBeTruthy();
    const call = server.areas.aiAdmin.calls.at(-1);
    expect(call?.path).toBe("/api/orgs/o1/dashboards/d-sales/panels/p-orders/ai/summarize");
    expect(call?.body).toMatchObject({ variables: {}, language: "en" });
    expect(call?.body.timeRange).toBeTruthy();
    // "In Fragen weiterfragen" opens a chat about the dashboard, the question ready.
    await user.click(await within(dialog).findByRole("link", { name: "Continue in Ask" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Summary: Orders" })).toBeNull(),
    );
    const question = await screen.findByRole("textbox", { name: "Question about your data" });
    expect((question as HTMLTextAreaElement).value).toBe("Tell me more about the panel “Orders”.");
    expect(await screen.findByText("Context: Sales")).toBeTruthy();
  });

  it("opens a panel in Ask from its menu, with the dashboard as context", async () => {
    const { user } = dashboard(USABLE);
    const panel = await screen.findByRole("article", { name: "Orders" });
    await user.click(within(panel).getByRole("button", { name: "Panel menu of “Orders”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Open Orders in Ask" }));
    const question = await screen.findByRole("textbox", { name: "Question about your data" });
    expect((question as HTMLTextAreaElement).value).toBe("What does the panel “Orders” show?");
    expect(await screen.findByText("Context: Sales")).toBeTruthy();
  });
});
