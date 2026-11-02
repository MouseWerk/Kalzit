import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { resetActiveTip } from "../../help/tips";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import {
  addMongoSource,
  addNeo4jSource,
  MONGO_ID,
  PG_ID,
} from "../datasources/test/fakeDatasources";
import { NEO4J_ID } from "../datasources/test/fakeGraph";

afterEach(() => resetActiveTip());

function open(role = "editor", options: { tips?: boolean; grant?: boolean } = {}) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
    tips: options.tips === true,
  });
  addMongoSource(server.areas.datasources);
  addNeo4jSource(server.areas.datasources);
  if (options.grant === true) {
    server.areas.datasources.grants[PG_ID] = "query";
  }
  return { server, ...renderApp("/explore") };
}

/** Explore on the PostgreSQL source (the MongoDB one sorts first). */
async function openPg(role = "editor", options: { tips?: boolean } = {}) {
  const opened = open(role, options);
  await opened.user.selectOptions(
    await screen.findByRole("combobox", { name: "Data source" }),
    PG_ID,
  );
  return opened;
}

const sent = (server: ReturnType<typeof installFakeServer>) =>
  (server.areas.datasources.queries.at(-1) as unknown as QueryRequest | undefined)?.queries[0]
    ?.query;

async function startPanel() {
  return screen.findByRole("region", { name: "Start here: PostgreSQL" });
}

describe("Explore's start panel", () => {
  it("explains the source and runs a starter with a real table name", async () => {
    const { server, user } = await openPg();
    const start = await startPanel();
    expect(within(start).getByText(/This source holds tables/)).toBeTruthy();
    // The tables of the schema are offered, the first one picked.
    const pick = within(start).getByRole("combobox", { name: "Table for the examples" });
    expect(
      within(pick)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["public.orders", "public.customers"]);
    // The query is there to see before it is used.
    await user.click(within(start).getAllByText("Show the query")[0] as HTMLElement);
    expect(within(start).getByText(/SELECT \* FROM orders LIMIT 100/)).toBeTruthy();

    await user.selectOptions(pick, "customers");
    await user.click(
      within(start).getByRole("button", { name: "Show the first 100 rows of a table" }),
    );
    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(sent(server)).toEqual({ sql: "SELECT *\nFROM customers\nLIMIT 100" });
    // The query stays in the editor to learn from; the start panel has done its job.
    expect(screen.getByRole("textbox", { name: "Query" })).toHaveProperty(
      "value",
      "SELECT *\nFROM customers\nLIMIT 100",
    );
    expect(screen.queryByRole("region", { name: "Start here: PostgreSQL" })).toBeNull();
  });

  it("offers time starters only for tables with a time column", async () => {
    const { user } = await openPg();
    const start = await startPanel();
    expect(
      within(start).getByRole("button", { name: "Latest rows in the time range" }),
    ).toBeTruthy();
    expect(within(start).getByRole("button", { name: "A number over time" })).toBeTruthy();
    await user.selectOptions(within(start).getByRole("combobox"), "customers");
    expect(
      within(start).queryByRole("button", { name: "Latest rows in the time range" }),
    ).toBeNull();
  });

  it("builds without a query: runs the rows and leads to the steps", async () => {
    const { server, user } = await openPg();
    const start = await startPanel();
    await user.click(within(start).getByRole("button", { name: "Build without writing a query" }));
    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(sent(server)).toEqual({ sql: "SELECT *\nFROM orders\nLIMIT 100" });
    const aside = screen.getByRole("complementary", { name: /Steps/ });
    await waitFor(() => expect(aside.contains(document.activeElement)).toBe(true));
  });

  it("follows the source: a MongoDB collection and a graph label", async () => {
    const { server, user } = await openPg();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Data source" }),
      MONGO_ID,
    );
    const mongo = await screen.findByRole("region", { name: /^Start here: MongoDB/ });
    await user.click(within(mongo).getByRole("button", { name: "Count all documents" }));
    await waitFor(() =>
      expect(sent(server)).toEqual({
        collection: "orders",
        pipeline: '[\n  {"$count":"n"}\n]',
      }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Data source" }), NEO4J_ID);
    const graph = await screen.findByRole("region", { name: /^Start here: Neo4j/ });
    expect(
      within(graph).getByRole("combobox", { name: "Node label for the examples" }),
    ).toBeTruthy();
    expect(within(graph).getByRole("button", { name: "Find nodes with a label" })).toBeTruthy();
  });

  it("hands over to Fragen only while AI is on", async () => {
    await openPg();
    const start = await startPanel();
    // AI is off in the fake server: no entry, no placeholder.
    expect(within(start).queryByRole("link", { name: "Ask in plain language" })).toBeNull();
    expect(
      within(start).getByRole("link", { name: /Guide to PostgreSQL for beginners/ }),
    ).toHaveProperty("href", expect.stringContaining("query-languages.md#postgresql"));
  });
});

describe("Explore's schema list", () => {
  it("inserts and runs the matching query for a table", async () => {
    const { server, user } = await openPg();
    const schema = await screen.findByRole("region", { name: "Schema" });
    await user.click(within(schema).getByRole("button", { name: "Count: public.customers" }));
    await waitFor(() =>
      expect(sent(server)).toEqual({ sql: "SELECT COUNT(*) AS n\nFROM customers" }),
    );
    await user.click(within(schema).getByRole("button", { name: "Show structure: public.orders" }));
    await waitFor(() =>
      expect((sent(server) as { sql: string }).sql).toMatch(
        /FROM information_schema\.columns\nWHERE table_name = 'orders' AND table_schema = 'public'/,
      ),
    );
    fireEvent.change(within(schema).getByRole("searchbox", { name: "Search the schema" }), {
      target: { value: "cust" },
    });
    expect(within(schema).queryByText("public.orders")).toBeNull();
  });
});

describe("Explore's cheat sheet", () => {
  it("opens with its button and Ctrl+/, searches, and inserts without running", async () => {
    const { server, user } = await openPg();
    await startPanel();
    await user.click(screen.getByRole("button", { name: "Cheat sheet" }));
    const sheet = screen.getByRole("region", { name: "Cheat sheet: SQL" });
    expect(
      within(sheet).getByText(/^Time range: \$__timeFilter\(column\) keeps the rows/),
    ).toBeTruthy();
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Search the cheat sheet" }), {
      target: { value: "join" },
    });
    expect(within(sheet).getByRole("heading", { name: "Join two tables" })).toBeTruthy();
    expect(within(sheet).queryByRole("heading", { name: "Sort" })).toBeNull();
    const before = server.areas.datasources.queries.length;
    await user.click(within(sheet).getByRole("button", { name: "Insert: Join two tables" }));
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toMatch(
      /JOIN customers AS b ON b\.\w+ = a\.\w+/,
    );
    expect(server.areas.datasources.queries.length).toBe(before);
    // A dashboard variable is shown, not inserted: Explore has none.
    fireEvent.change(within(sheet).getByRole("searchbox"), { target: { value: "variable" } });
    expect(within(sheet).queryByRole("button", { name: /^Insert/ })).toBeNull();

    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(screen.queryByRole("region", { name: "Cheat sheet: SQL" })).toBeNull();
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    expect(screen.getByRole("region", { name: "Cheat sheet: SQL" })).toBeTruthy();
  });
});

describe("Explore's guide and the editor", () => {
  it("leaves Ctrl+/ to the editor and opens the cheat sheet with Shift+F1 there", async () => {
    await openPg();
    const editor = await screen.findByRole("textbox", { name: "Query" });
    fireEvent.keyDown(editor, { key: "/", ctrlKey: true });
    expect(screen.queryByRole("region", { name: "Cheat sheet: SQL" })).toBeNull();
    fireEvent.keyDown(editor, { key: "F1", shiftKey: true });
    expect(screen.getByRole("region", { name: "Cheat sheet: SQL" })).toBeTruthy();
  });

  it("offers to undo a schema action that replaced the query", async () => {
    const { user } = await openPg();
    const editor = await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(editor, { target: { value: "SELECT 1" } });
    const schema = screen.getByRole("region", { name: "Schema" });
    await user.click(within(schema).getByRole("button", { name: "Count: public.customers" }));
    expect(await screen.findByText("The query in the editor was replaced.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toMatch(
      /COUNT/,
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe(
        "SELECT 1",
      ),
    );
  });
});

describe("Explore's error hints", () => {
  it("explains an unknown table and leads to the schema", async () => {
    const { server, user } = await openPg();
    server.areas.datasources.respond = () => ({
      error: {
        code: "datasource_error",
        reason: "source.error",
        message: 'relation "ordrs" does not exist',
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT * FROM ordrs" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    const hint = await screen.findByRole("note", { name: "Hint" });
    expect(hint.textContent).toMatch(/There is no table ordrs in this source/);
    await user.click(within(hint).getByRole("button", { name: "Find it in the schema" }));
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Search the schema" }),
    );
  });

  it("points a syntax error to the cheat sheet's basics", async () => {
    const { server, user } = await openPg();
    server.areas.datasources.respond = () => ({
      error: {
        code: "datasource_error",
        reason: "source.error",
        message: 'syntax error at or near "FORM"',
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT * FORM orders" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    const hint = await screen.findByRole("note", { name: "Hint" });
    expect(hint.textContent).toMatch(/near FORM/);
    await user.click(within(hint).getByRole("button", { name: "Show in the cheat sheet" }));
    const sheet = screen.getByRole("region", { name: "Cheat sheet: SQL" });
    expect(sheet.querySelector('[data-highlighted="true"]')?.getAttribute("data-snippet")).toBe(
      "rows",
    );
  });

  it("stays away from errors it cannot explain", async () => {
    const { server, user } = await openPg();
    server.areas.datasources.respond = () => ({
      error: { code: "datasource_error", reason: "source.error", message: "something odd" },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT 1" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText(/The data source reported an error/)).toBeTruthy();
    expect(screen.queryByRole("note", { name: "Hint" })).toBeNull();
  });
});

describe("the query behind a group step", () => {
  it("shows the SQL of a group step and takes it over", async () => {
    const { server, user } = await openPg();
    const start = await startPanel();
    await user.click(
      within(start).getByRole("button", { name: "Show the first 100 rows of a table" }),
    );
    await screen.findByText("Grace");
    const aside = screen.getByRole("complementary", { name: /Steps/ });
    await user.selectOptions(within(aside).getAllByRole("combobox")[0] as HTMLElement, "group");
    await user.click(within(aside).getByRole("button", { name: /Add step/ }));
    const show = await within(aside).findByText("Show the query of this step");
    await user.click(show);
    expect(within(aside).getByText(/FROM \( SELECT \*/)).toBeTruthy();
    await user.click(
      within(aside).getByRole("button", { name: "Use this query instead of the step" }),
    );
    await waitFor(() =>
      expect((sent(server) as { sql: string }).sql).toMatch(/^SELECT .*\nFROM \(/),
    );
  });
});

describe("Explore's tips", () => {
  it("show once after the first result, close, and can be turned off", async () => {
    const { server, user } = await openPg("editor", { tips: true });
    const start = await startPanel();
    await user.click(within(start).getByRole("button", { name: "Count all rows" }));
    const tip = await screen.findByRole("note", { name: "Tip" });
    expect(tip.textContent).toMatch(/Add WHERE after FROM/);
    // Seen as soon as it shows, on the server, so it follows the person.
    await waitFor(() =>
      expect(server.state.preferences.seenTips).toContain("explore.first-result"),
    );
    await user.click(within(tip).getByRole("button", { name: "Turn off tips" }));
    expect(screen.queryByRole("note", { name: "Tip" })).toBeNull();
    await waitFor(() => expect(server.state.preferences.showTips).toBe(false));
  });

  it("stay away while tips are off", async () => {
    const { user } = await openPg();
    const start = await startPanel();
    await user.click(within(start).getByRole("button", { name: "Count all rows" }));
    await screen.findByText("Grace");
    expect(screen.queryByRole("note", { name: "Tip" })).toBeNull();
  });
});

describe("Explore's guidance and rights", () => {
  it("is not there for a viewer without query access", async () => {
    open("viewer");
    expect(
      await screen.findByRole("heading", { name: "Explore is not available to your role" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Start here/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cheat sheet" })).toBeNull();
  });

  it("guides a viewer with a query grant on that source only", async () => {
    open("viewer", { grant: true });
    expect(await startPanel()).toBeTruthy();
    const sources = screen.getByRole("combobox", { name: "Data source" });
    expect(
      within(sources)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual([PG_ID]);
  });
});
