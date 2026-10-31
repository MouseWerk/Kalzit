import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../../test/fakeServer";
import { renderApp } from "../../../test/renderApp";
import { emptyModel } from "../../dashboards/model";
import { addDashboard } from "../../dashboards/test/fakeDashboards";
import { PG_ID, PROM_ID } from "../../datasources/test/fakeDatasources";
import type { ToolRecord, Turn } from "./api";
import { CHAT_T0, chatMessages, fakeChat } from "./test/fakeAiChat";
import { addCall, addText, daysLeft, queriesRun, queryText, setRecord, stepsOf } from "./turn";

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
    leavesNetworkEstimated: true,
    usable: true,
    reachable: true,
    noticeAcknowledged: true,
  },
  usage: {
    requests: 46,
    tokens: 500,
    requestsLimit: 200,
    tokensLimit: 0,
    orgTokensMonth: 0,
    orgTokensMonthLimit: 0,
  },
  maxRowsToModel: 200,
};

const QUERY_RECORD: ToolRecord = {
  status: "ok",
  datasource: { id: PG_ID, name: "Sales DB", kind: "postgres" },
  query: { sql: "SELECT region, sum(betrag) AS umsatz FROM bestellungen GROUP BY region" },
  results: [
    {
      refId: "A",
      datasourceId: PG_ID,
      rows: 2,
      truncated: false,
      excludedValues: 1,
      data: {
        shape: "frame",
        fields: [
          { name: "region", values: ["Nord", "Süd"] },
          { name: "umsatz", values: [412, 538] },
        ],
      },
    },
  ],
  durationMs: 84,
};

const TURN: Turn = {
  rounds: [
    {
      text: "",
      calls: [
        { id: "c1", name: "run_query", arguments: { datasourceId: PG_ID }, record: QUERY_RECORD },
      ],
    },
    { text: "Süd liegt vorn.", calls: [] },
  ],
  usage: { inputTokens: 1200, outputTokens: 34 },
  provider: { name: "Lokal", kind: "openai", model: "modell-1", host: "llm.intern" },
  outcome: "ok",
};

function open(
  path: string,
  status: Record<string, unknown> | null,
  role = "owner",
  isServerAdmin = false,
) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin, orgs: [{ id: "o1", name: "Org", role }] },
  });
  if (status !== null) {
    server.areas.aiAdmin.status = status;
  }
  server.areas.aiAdmin.access = {
    [PG_ID]: { readable: true, excludedFields: ["kunden.email"] },
  };
  return { server, ...renderApp(path) };
}

describe("Fragen: parts", () => {
  it("builds the same steps from a stored answer and from streamed events", () => {
    const stored = stepsOf(TURN);
    expect(stored.map((step) => step.kind)).toEqual(["call", "text"]);
    let live = addCall([], { id: "c1", name: "run_query", arguments: { datasourceId: PG_ID } });
    expect(queriesRun(live)).toBe(0);
    live = setRecord(live, "c1", QUERY_RECORD);
    live = addText(addText(live, "Süd liegt "), "vorn.");
    expect(live).toEqual(stored);
    expect(queriesRun(live)).toBe(1);
  });

  it("reads the query text and the days a chat has left", () => {
    expect(queryText({ sql: "SELECT 1" })).toBe("SELECT 1");
    expect(queryText({ collection: "orders", pipeline: "[]" })).toContain('"collection"');
    const day = 24 * 3600 * 1000;
    expect(daysLeft(CHAT_T0 + 3 * day, CHAT_T0)).toBe(3);
    expect(daysLeft(CHAT_T0 + 1, CHAT_T0)).toBe(1);
    expect(daysLeft(CHAT_T0 - 1, CHAT_T0)).toBe(0);
  });
});

describe("Fragen", () => {
  it("has no entry and no page while AI is off", async () => {
    const { server } = open("/ask", null);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/ai/status"))).toBe(true),
    );
    expect(screen.queryByRole("link", { name: /^Ask/ })).toBeNull();
  });

  it("shows the entry with Beta, the provider, today's requests and the allowed sources", async () => {
    open("/ask", USABLE);
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(await within(nav).findByRole("link", { name: "Ask Beta" })).toBeTruthy();
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(within(pane).getByText("Lokal · modell-1")).toBeTruthy();
    expect(within(pane).getByText("llm.intern:11434")).toBeTruthy();
    expect(within(pane).getByText("Last check passed")).toBeTruthy();
    expect(
      within(pane).getByText("By its address in the own network; a gateway there may forward"),
    ).toBeTruthy();
    const open_ = await within(pane).findByRole("checkbox", { name: "Allow Sales DB" });
    expect((open_ as HTMLInputElement).disabled).toBe(false);
    const closed = within(pane)
      .getAllByRole("checkbox")
      .find((box) => box.getAttribute("aria-describedby")?.endsWith(PROM_ID));
    expect((closed as HTMLInputElement).disabled).toBe(true);
    expect(within(pane).getByText("AI may not read")).toBeTruthy();
    expect(screen.getByText("Today 46 of 200 requests")).toBeTruthy();
  });

  it("links organization admins only to pages they can open", async () => {
    // Under the server's provider: who chooses it, and the organization's own page.
    open("/ask", USABLE, "admin");
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      await within(pane).findByText(/Server administrators choose model and provider\. You can/),
    ).toBeTruthy();
    expect(
      within(pane)
        .getByRole("link", { name: "Settings > AI of the organization" })
        .getAttribute("href"),
    ).toBe("/settings/org-ai");
    expect(within(pane).queryByRole("link", { name: "Settings > AI" })).toBeNull();
  });

  it("only names the server admins when organizations may not add a provider", async () => {
    open("/ask", { ...USABLE, orgProvidersAllowed: false }, "admin");
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      await within(pane).findByText("Server administrators choose model and provider."),
    ).toBeTruthy();
    expect(within(pane).queryByRole("link", { name: /^Settings > AI/ })).toBeNull();
  });

  it("links organization admins to the organization's page for its own provider", async () => {
    const ownProvider = { ...USABLE, provider: { ...USABLE.provider, scope: "org" } };
    open("/ask", ownProvider, "admin");
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      (
        await within(pane).findByRole("link", { name: "Settings > AI of the organization" })
      ).getAttribute("href"),
    ).toBe("/settings/org-ai");
  });

  it("links server admins to the server's AI page under the server's provider", async () => {
    // Also without the right to change the organization's settings.
    open("/ask", USABLE, "viewer", true);
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      (await within(pane).findByRole("link", { name: "Settings > AI" })).getAttribute("href"),
    ).toBe("/settings/ai");
    expect(
      within(pane).queryByRole("link", { name: "Settings > AI of the organization" }),
    ).toBeNull();
  });

  it("names the organization's admins to a server admin who cannot change its own provider", async () => {
    const ownProvider = { ...USABLE, provider: { ...USABLE.provider, scope: "org" } };
    open("/ask", ownProvider, "viewer", true);
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      await within(pane).findByText("This organization’s administrators choose its provider."),
    ).toBeTruthy();
    expect(within(pane).queryByRole("link", { name: /^Settings > AI/ })).toBeNull();
  });

  it("links a server admin who also administers the organization to its own provider's page", async () => {
    const ownProvider = { ...USABLE, provider: { ...USABLE.provider, scope: "org" } };
    open("/ask", ownProvider, "owner", true);
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    expect(
      (
        await within(pane).findByRole("link", { name: "Settings > AI of the organization" })
      ).getAttribute("href"),
    ).toBe("/settings/org-ai");
    expect(within(pane).queryByRole("link", { name: "Settings > AI" })).toBeNull();
  });

  it("shows members who cannot change settings no settings link", async () => {
    open("/ask", USABLE, "viewer");
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    await within(pane).findByText("Lokal · modell-1");
    expect(within(pane).queryByRole("link", { name: /^Settings > AI/ })).toBeNull();
    expect(within(pane).queryByText(/choose model and provider/)).toBeNull();
  });

  it("asks for the notice, then streams every tool call and the answer, and keeps the chat", async () => {
    const { server, user, location } = open("/ask", { ...USABLE, noticeAcknowledged: false });
    server.areas.aiChat.answer = {
      events: [
        { event: "meta", data: { chatId: "chat-1", provider: USABLE.provider } },
        {
          event: "tool",
          data: { id: "c1", name: "run_query", arguments: { datasourceId: PG_ID } },
        },
        { event: "toolResult", data: { id: "c1", record: QUERY_RECORD } },
        { event: "text", data: { text: "Süd liegt " } },
        { event: "text", data: { text: "vorn." } },
        { event: "done", data: { usage: TURN.usage, outcome: "ok", toolCalls: 1 } },
      ],
      turn: TURN,
    };
    const pane = await screen.findByRole("complementary", { name: "Context and controls" });
    await user.click(await within(pane).findByRole("checkbox", { name: "Allow Sales DB" }));
    const question = screen.getByRole("textbox", { name: "Question about your data" });
    await user.type(question, "Wie entwickelt sich der Umsatz je Region?{Enter}");
    const notice = await screen.findByRole("dialog", { name: "Before you use AI" });
    expect(within(notice).getByText(/For “Ask”, your questions/)).toBeTruthy();
    expect(server.areas.aiChat.asks).toHaveLength(0);
    await user.click(within(notice).getByRole("button", { name: "Got it" }));

    const answer = await screen.findByRole("article", { name: "Answer of the assistant" });
    expect(await within(answer).findByText("Süd liegt vorn.")).toBeTruthy();
    expect(within(answer).getByText("Data used and query")).toBeTruthy();
    expect(within(answer).getByText("Table bestellungen")).toBeTruthy();
    expect(within(answer).getByText(/1 query, read-only/)).toBeTruthy();
    expect(within(answer).getByRole("cell", { name: "Süd" })).toBeTruthy();
    expect(within(answer).getByText("Excluded values: 1.")).toBeTruthy();
    expect(within(answer).getByText(/SELECT region, sum\(betrag\)/)).toBeTruthy();
    expect(within(answer).getByRole("button", { name: "Open in Explore" })).toBeTruthy();
    expect(within(answer).getByText("1,234 tokens")).toBeTruthy();
    expect(server.areas.aiChat.asks).toEqual([
      {
        chatId: "chat-1",
        body: {
          text: "Wie entwickelt sich der Umsatz je Region?",
          datasourceIds: [PG_ID],
          language: "en",
        },
      },
    ]);
    // The new chat gets its address and shows what the server stored.
    await waitFor(() => expect(location().search).toEqual({ chat: "chat-1" }));
    expect(
      await screen.findByText("Wie entwickelt sich der Umsatz je Region?", {
        selector: ".ask-question__text",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Süd liegt vorn.")).toBeTruthy();
  });

  it("opens a query of an answer in Explore without running it", async () => {
    const { server, user, location } = open("/ask?chat=c-old", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-old", title: "Umsatz", messages: chatMessages("Umsatz?", TURN) }),
    ];
    const answer = await screen.findByRole("article", { name: "Answer of the assistant" });
    const before = server.areas.datasources.queries.length;
    await user.click(within(answer).getByRole("button", { name: "Open in Explore" }));
    await waitFor(() => expect(location().pathname).toBe("/explore"));
    expect(server.areas.datasources.queries.length).toBe(before);
  });

  it("chooses sources with + Source and leaves out one that is gone", async () => {
    const { server, user } = open("/ask?chat=c-gone", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-gone", title: "Alt", datasourceIds: ["ds-deleted"] }),
    ];
    const composer = await screen.findByRole("form", { name: "Ask a question" });
    expect(await within(composer).findByText("All sources open to AI")).toBeTruthy();
    await user.click(within(composer).getByRole("button", { name: "+ Source" }));
    await user.click(within(composer).getByRole("checkbox", { name: "Allow Sales DB" }));
    expect(within(composer).getByRole("button", { name: "Remove Sales DB" })).toBeTruthy();
    await user.type(within(composer).getByRole("textbox"), "Frage{Enter}");
    await waitFor(() => expect(server.areas.aiChat.asks).toHaveLength(1));
    expect(server.areas.aiChat.asks[0]?.body.datasourceIds).toEqual([PG_ID]);
  });

  it("gives a refused question back to the composer with the reason", async () => {
    const { server, user } = open("/ask", USABLE);
    server.areas.aiChat.answer = {
      refusal: {
        status: 429,
        code: "rate_limited",
        reason: "ai.limit_user_requests",
        params: { max: "200" },
      },
    };
    const question = await screen.findByRole("textbox", { name: "Question about your data" });
    await user.type(question, "Noch eine Frage{Enter}");
    expect(await screen.findByText(/You used your 200 AI calls for today/)).toBeTruthy();
    expect((question as HTMLTextAreaElement).value).toBe("Noch eine Frage");
  });

  it("locks Send with the reason when the daily limit is used up", async () => {
    open("/ask", { ...USABLE, usage: { ...USABLE.usage, requests: 200 } });
    const send = await screen.findByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You used your 200 AI calls for today/)).toBeTruthy();
  });

  it("shows a withheld result and a stopped call as such", async () => {
    const stopped: Turn = {
      rounds: [
        {
          text: "",
          calls: [
            {
              id: "c1",
              name: "run_query",
              arguments: {},
              record: { ...QUERY_RECORD, withheld: true, results: [] },
            },
            { id: "c2", name: "get_schema", arguments: {} },
          ],
        },
      ],
      outcome: "stopped",
    };
    const { server } = open("/ask?chat=c-w", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-w", title: "Alt", messages: chatMessages("Alt?", stopped) }),
    ];
    expect(await screen.findByText(/No longer available/)).toBeTruthy();
    expect(screen.getByText("Stopped. What arrived until then is kept.")).toBeTruthy();
    expect(screen.queryByText(/Answer withheld/)).toBeNull();
  });

  it("says why the words of an answer are withheld and offers none of its queries", async () => {
    const withheld: Turn = {
      rounds: [
        {
          text: "",
          calls: [
            {
              id: "c1",
              name: "run_query",
              arguments: {},
              record: { ...QUERY_RECORD, query: undefined },
            },
          ],
        },
        { text: "", calls: [] },
      ],
      outcome: "ok",
      withheld: true,
    };
    const { server } = open("/ask?chat=c-h", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-h", title: "Alt", messages: chatMessages("Alt?", withheld) }),
    ];
    const answer = await screen.findByRole("article", { name: "Answer of the assistant" });
    expect(
      within(answer).getByText(
        "Answer withheld because access to its data changed. The remaining results are shown as the rules apply now.",
      ),
    ).toBeTruthy();
    // The result as the rules allow now stays; nothing of the model's is offered to save.
    expect(within(answer).getByText("Süd")).toBeTruthy();
    expect(within(answer).queryByRole("button", { name: "Save as panel" })).toBeNull();
  });
});

describe("Fragen: from the board", () => {
  it("offers the answer's query as a panel, on a dashboard and to adjust, never run here", async () => {
    const { server, user, location } = open("/ask?chat=c-act", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-act", title: "Umsatz", messages: chatMessages("Umsatz?", TURN) }),
    ];
    const answer = await screen.findByRole("article", { name: "Answer of the assistant" });
    await user.click(within(answer).getByRole("button", { name: "Add to dashboard" }));
    const dialog = await screen.findByRole("dialog", { name: "Add to dashboard" });
    // The query is shown again in full, read-only, before anything is saved.
    const shown = within(dialog).getByLabelText("Query (read-only)");
    expect(shown.textContent).toBe(
      "SELECT region, sum(betrag) AS umsatz FROM bestellungen GROUP BY region",
    );
    expect(shown.querySelector("pre")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const before = server.areas.datasources.queries.length;
    await user.click(within(answer).getByRole("button", { name: "Save as panel" }));
    await waitFor(() => expect(location().pathname).toBe("/explore"));
    const save = await screen.findByRole("dialog", { name: "Save analysis" });
    expect(within(save).getByLabelText("Query (read-only)").textContent).toBe(
      "SELECT region, sum(betrag) AS umsatz FROM bestellungen GROUP BY region",
    );
    expect(server.areas.datasources.queries.length).toBe(before);
  });

  it("switches a result over time between table and time series", async () => {
    const series: Turn = {
      rounds: [
        {
          text: "",
          calls: [
            {
              id: "c1",
              name: "run_query",
              arguments: {},
              record: {
                ...QUERY_RECORD,
                results: [
                  {
                    refId: "A",
                    rows: 3,
                    truncated: false,
                    excludedValues: 0,
                    data: {
                      shape: "frame",
                      fields: [
                        {
                          name: "tag",
                          type: "time",
                          values: [CHAT_T0, CHAT_T0 + 1000, CHAT_T0 + 2000],
                        },
                        { name: "umsatz", type: "number", values: [1, 3, 2] },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      outcome: "ok",
    };
    const { server, user } = open("/ask?chat=c-ts", USABLE);
    server.areas.aiChat.chats = [
      fakeChat({ id: "c-ts", title: "Verlauf", messages: chatMessages("Verlauf?", series) }),
    ];
    const answer = await screen.findByRole("article", { name: "Answer of the assistant" });
    const table = within(answer).getByRole("table");
    // Number columns are marked to be end-aligned; the others are not.
    expect(within(table).getByRole("columnheader", { name: "umsatz" }).dataset.numeric).toBe(
      "true",
    );
    expect(
      within(table).getByRole("columnheader", { name: "tag" }).dataset.numeric,
    ).toBeUndefined();
    await user.click(within(answer).getByRole("button", { name: "Time series" }));
    expect(within(answer).getByRole("img", { name: /^umsatz from / })).toBeTruthy();
    expect(within(answer).queryByRole("table")).toBeNull();
  });

  it("asks about a dashboard chosen as context", async () => {
    const { server, user } = open("/ask", USABLE);
    addDashboard(server.areas.dashboards, "d-region", emptyModel("Umsatz nach Region"));
    const composer = await screen.findByRole("form", { name: "Ask a question" });
    await user.click(within(composer).getByRole("button", { name: "Dashboard as context" }));
    await user.click(await within(composer).findByRole("button", { name: "Umsatz nach Region" }));
    expect(within(composer).getByText("Context: Umsatz nach Region")).toBeTruthy();
    await user.click(
      within(composer).getByRole("button", { name: "Remove the dashboard context" }),
    );
    expect(within(composer).queryByText("Context: Umsatz nach Region")).toBeNull();
    await user.click(within(composer).getByRole("button", { name: "Dashboard as context" }));
    await user.click(await within(composer).findByRole("button", { name: "Umsatz nach Region" }));
    await user.type(within(composer).getByRole("textbox"), "Was fällt auf?{Enter}");
    await waitFor(() => expect(server.areas.aiChat.asks).toHaveLength(1));
    expect(server.areas.aiChat.asks[0]?.body.dashboardId).toBe("d-region");
  });
});

describe("Fragen: history", () => {
  it("lists the chats with when they are deleted, and deletes one after a confirmation", async () => {
    const { server, user } = open("/ask/history", USABLE);
    const day = 24 * 3600 * 1000;
    server.areas.aiChat.chats = [
      fakeChat({
        id: "a",
        title: "Umsatz je Region",
        expiresAt: Date.now() + 29.5 * day,
        datasources: [{ id: PG_ID, name: "Sales DB", kind: "postgres" }],
      }),
      fakeChat({ id: "b", title: "Retouren im September", expiresAt: Date.now() + 2.5 * day }),
    ];
    expect(await screen.findByRole("heading", { name: "History", level: 1 })).toBeTruthy();
    expect(
      await screen.findByText(/Chats are deleted 30 days after their last message/),
    ).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Umsatz je Region" })).toBeTruthy();
    expect(screen.getByText("30 days left")).toBeTruthy();
    expect(screen.getByText("3 days left")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete Retouren im September" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete the chat?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.areas.aiChat.chats.map((chat) => chat.id)).toEqual(["a"]));
    await waitFor(() => expect(screen.queryByText("Retouren im September")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Delete all" }));
    const all = await screen.findByRole("dialog", { name: "Delete all chats?" });
    await user.click(within(all).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(server.areas.aiChat.chats).toEqual([]));
    expect(await screen.findByText("No chats yet.")).toBeTruthy();
  });
});
