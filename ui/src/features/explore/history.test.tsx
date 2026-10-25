import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID, PROM_ID } from "../datasources/test/fakeDatasources";
import { queryPreview } from "./HistoryPanel";
import type { HistoryEntry } from "./history";

function entry(n: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `e${n}`,
    datasourceId: PG_ID,
    datasourceName: "Sales DB",
    datasourceKind: "postgres",
    query: { sql: `SELECT ${n} FROM orders` },
    shape: "frame",
    rowCount: n,
    durationMs: 5,
    createdAt: Date.now() - n * 3_600_000,
    ...over,
  };
}

function open(entries: HistoryEntry[] = []) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  server.areas.exploreHistory.entries = entries;
  return { server, ...renderApp("/explore") };
}

async function openPanel(user: ReturnType<typeof open>["user"]) {
  await user.click(await screen.findByRole("button", { name: "History" }));
  return await screen.findByRole("complementary", { name: "History" });
}

describe("query preview", () => {
  it("shows the query as one line", () => {
    expect(queryPreview({ sql: "SELECT a\n  FROM   t" })).toBe("SELECT a FROM t");
    expect(queryPreview({ expr: "up" })).toBe("up");
    expect(queryPreview([{ $match: {} }])).toBe('[{"$match":{}}]');
  });
});

describe("Explore history", () => {
  it("says who sees it and for how long, and shows an empty state", async () => {
    const { user } = open();
    const panel = await openPanel(user);
    expect(within(panel).getByText("Only visible to you, kept for 30 days.")).toBeTruthy();
    expect(await within(panel).findByText(/No history yet/)).toBeTruthy();
    expect(
      (within(panel).getByRole("button", { name: "Clear history" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps a run from Explore and lists it with its source, query and row count", async () => {
    const { server, user } = open();
    const editor = await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(editor, { target: { value: "SELECT * FROM customers" } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByText("Grace");
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(sent.explore).toBe(true);
    const panel = await openPanel(user);
    const load = await within(panel).findByRole("button", {
      name: "Load into the editor: SELECT * FROM customers",
    });
    expect(within(load).getByText("Sales DB")).toBeTruthy();
    expect(within(load).getByText("SELECT * FROM customers")).toBeTruthy();
  });

  it("loads an entry into the editor without running it", async () => {
    const { server, user } = open([
      entry(1),
      entry(2, {
        datasourceId: PROM_ID,
        datasourceName: "Metrics",
        datasourceKind: "prometheus",
        query: { expr: "up" },
      }),
    ]);
    const panel = await openPanel(user);
    await user.click(
      await within(panel).findByRole("button", {
        name: "Load into the editor: SELECT 1 FROM orders",
      }),
    );
    const editor = await screen.findByRole("textbox", { name: "Query" });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("SELECT 1 FROM orders"));
    expect(server.areas.datasources.queries).toHaveLength(0);
    // An entry of another source switches the source.
    await user.click(within(panel).getByRole("button", { name: "Load into the editor: up" }));
    expect(screen.getByRole("combobox", { name: "Data source" })).toHaveProperty("value", PROM_ID);
    expect(server.areas.datasources.queries).toHaveLength(0);
  });

  it("runs an entry again from its run button", async () => {
    const { server, user } = open([entry(1)]);
    const panel = await openPanel(user);
    await user.click(
      await within(panel).findByRole("button", { name: "Run again: SELECT 1 FROM orders" }),
    );
    await waitFor(() => expect(server.areas.datasources.queries).toHaveLength(1));
    const sent = server.areas.datasources.queries[0] as QueryRequest;
    expect(sent.queries[0]).toMatchObject({
      datasourceId: PG_ID,
      query: { sql: "SELECT 1 FROM orders" },
    });
    expect(sent.explore).toBe(true);
  });

  it("searches, filters by data source and deletes one entry", async () => {
    const { server, user } = open([
      entry(1),
      entry(2),
      entry(3, {
        datasourceId: PROM_ID,
        datasourceName: "Metrics",
        datasourceKind: "prometheus",
        query: { expr: "up" },
      }),
    ]);
    const panel = await openPanel(user);
    expect(await within(panel).findAllByRole("listitem")).toHaveLength(3);
    await user.type(within(panel).getByRole("searchbox", { name: "Search history" }), "SELECT 2");
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
    await user.clear(within(panel).getByRole("searchbox", { name: "Search history" }));
    await user.selectOptions(
      within(panel).getByRole("combobox", { name: "Filter by data source" }),
      PROM_ID,
    );
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
    await user.type(within(panel).getByRole("searchbox", { name: "Search history" }), "zzz");
    expect(await within(panel).findByText("No query matches your search.")).toBeTruthy();
    await user.clear(within(panel).getByRole("searchbox", { name: "Search history" }));
    await user.selectOptions(
      within(panel).getByRole("combobox", { name: "Filter by data source" }),
      "",
    );
    await within(panel).findAllByRole("listitem");
    await user.click(
      within(panel).getByRole("button", { name: "Delete from history: SELECT 2 FROM orders" }),
    );
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(2));
    expect(server.areas.exploreHistory.entries.map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("clears the history only after a confirmation", async () => {
    const { server, user } = open([entry(1), entry(2)]);
    const panel = await openPanel(user);
    await within(panel).findAllByRole("listitem");
    await user.click(within(panel).getByRole("button", { name: "Clear history" }));
    const dialog = await screen.findByRole("dialog", { name: "Clear history" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.areas.exploreHistory.entries).toHaveLength(2);
    await user.click(within(panel).getByRole("button", { name: "Clear history" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Clear history" })).getByRole("button", {
        name: "Delete all",
      }),
    );
    await waitFor(() => expect(server.areas.exploreHistory.entries).toHaveLength(0));
    expect(await within(panel).findByText(/No history yet/)).toBeTruthy();
  });

  it("waits for a pause in typing before it searches", async () => {
    const { server, user } = open([entry(1), entry(2)]);
    const panel = await openPanel(user);
    await within(panel).findAllByRole("listitem");
    await user.type(within(panel).getByRole("searchbox", { name: "Search history" }), "SELECT 2");
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
    // One request for the whole word, not one per key.
    expect(server.areas.exploreHistory.searches.filter((q) => q !== "")).toEqual(["SELECT 2"]);
  });

  it("shows 50 entries and loads the rest on request", async () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(i + 1));
    const { user } = open(many);
    const panel = await openPanel(user);
    expect(await within(panel).findAllByRole("listitem")).toHaveLength(50);
    await user.click(within(panel).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(60));
    expect(within(panel).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("says that the query text is stored", async () => {
    const { user } = open();
    const panel = await openPanel(user);
    expect(within(panel).getByText(/including any values in it/)).toBeTruthy();
  });

  it("focuses its heading when it opens and the next entry after a delete", async () => {
    const { user } = open([entry(1), entry(2), entry(3)]);
    const panel = await openPanel(user);
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "History" }));
    await within(panel).findAllByRole("listitem");
    await user.click(
      within(panel).getByRole("button", { name: "Delete from history: SELECT 1 FROM orders" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole("button", { name: "Load into the editor: SELECT 2 FROM orders" }),
      ),
    );
    // The last entry gone: focus goes to the search.
    await user.click(
      within(panel).getByRole("button", { name: "Delete from history: SELECT 2 FROM orders" }),
    );
    await user.click(
      await within(panel).findByRole("button", {
        name: "Delete from history: SELECT 3 FROM orders",
      }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole("searchbox", { name: "Search history" }),
      ),
    );
  });

  it("is operable from the keyboard and closes with its close button", async () => {
    const { user } = open([entry(1)]);
    const panel = await openPanel(user);
    const load = await within(panel).findByRole("button", {
      name: "Load into the editor: SELECT 1 FROM orders",
    });
    load.focus();
    expect(document.activeElement).toBe(load);
    // Load, run and delete are real buttons: Tab reaches each, Enter activates them.
    await user.tab();
    expect(document.activeElement).toBe(
      within(panel).getByRole("button", { name: "Run again: SELECT 1 FROM orders" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      within(panel).getByRole("button", { name: "Delete from history: SELECT 1 FROM orders" }),
    );
    await user.click(within(panel).getByRole("button", { name: "Close history" }));
    expect(screen.queryByRole("complementary", { name: "History" })).toBeNull();
  });
});
