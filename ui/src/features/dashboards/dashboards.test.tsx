import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { PANEL_QUERY_CONCURRENCY } from "./queryQueue";
import { addDashboard, addFolder, latest, type StoredDashboard } from "./test/fakeDashboards";

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function sqlPanel(id: string, title: string, sql: string, x = 0, y = 0): PanelModel {
  return {
    id,
    type: "table",
    title,
    grid: { x, y, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: PG_ID, query: { sql, format: "table" } }],
    transformations: [],
    options: {},
    fieldConfig: {},
  };
}

function setup(role = "editor", panels?: PanelModel[]) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  const { dashboards } = server.areas;
  addFolder(dashboards, "f-ops", "Operations");
  addFolder(dashboards, "f-hr", "People", { restricted: true });
  const model = {
    ...emptyModel("Sales"),
    panels: panels ?? [
      sqlPanel("p-orders", "Orders", "SELECT * FROM orders"),
      sqlPanel("p-slow", "Slow", "SELECT pg_sleep(99) -- fail:query_timeout", 12, 0),
      {
        ...sqlPanel("p-mixed", "Mixed", "SELECT 1", 0, 8),
        targets: [
          { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1", format: "table" } },
          {
            refId: "B",
            datasourceId: PG_ID,
            query: { sql: "-- fail:query_rejected", format: "table" },
          },
        ],
      },
    ],
  };
  addDashboard(dashboards, "d-sales", model, { folderId: "f-ops" });
  addDashboard(dashboards, "d-people", emptyModel("Headcount"), { folderId: "f-hr" });
  return server;
}

/** Someone else saves a new version of the stored dashboard. */
function saveAsOther(stored: StoredDashboard, model: DashboardModel, message = "") {
  stored.versions.push({
    version: latest(stored).version + 1,
    message,
    authorId: "u2",
    authorName: "Grace Hopper",
    restoredFrom: null,
    createdAt: Date.UTC(2026, 9, 2),
    model,
  });
}

function storedSales(server: ReturnType<typeof setup>): StoredDashboard {
  const stored = server.areas.dashboards.dashboards.find((d) => d.id === "d-sales");
  if (stored === undefined) {
    throw new Error("no dashboard");
  }
  return stored;
}
const panelOf = (title: string) => screen.getByRole("article", { name: title });

describe("dashboard browser", () => {
  it("marks restricted folders for those who see them", async () => {
    setup("admin");
    const { user } = renderApp("/dashboards");
    const tree = await screen.findByRole("navigation", { name: "Folders" });
    expect(await within(tree).findByRole("button", { name: "People, Restricted" })).toBeTruthy();
    expect(within(tree).getByRole("button", { name: "Operations" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Sales" })).toBeTruthy();

    await user.click(within(tree).getByRole("button", { name: "People, Restricted" }));
    expect(await screen.findByRole("link", { name: "Headcount" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("link", { name: "Sales" })).toBeNull());
  });

  it("leaves restricted folders and their dashboards out for everyone else", async () => {
    setup("editor");
    renderApp("/dashboards");
    const tree = await screen.findByRole("navigation", { name: "Folders" });
    expect(await within(tree).findByRole("button", { name: "Operations" })).toBeTruthy();
    expect(within(tree).queryByText("People")).toBeNull();
    expect(await screen.findByRole("link", { name: "Sales" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Headcount" })).toBeNull();
  });

  it("searches dashboards by title", async () => {
    setup("admin");
    const { user } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Sales" });
    await user.type(screen.getByRole("searchbox", { name: "Search dashboards" }), "head");
    await waitFor(() => expect(screen.queryByRole("link", { name: "Sales" })).toBeNull());
    expect(screen.getByRole("link", { name: "Headcount" })).toBeTruthy();
  });

  it("creates a dashboard and opens it in edit mode", async () => {
    const server = setup();
    const { user, location } = renderApp("/dashboards");
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Capacity");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Capacity" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add panel" }).length).toBeGreaterThan(0);
    expect(location().pathname).toBe("/dashboards/dash-new-1");
    const created = server.areas.dashboards.dashboards.at(-1);
    expect(created === undefined ? "" : latest(created).model.title).toBe("Capacity");
  });
});

describe("dashboard view", () => {
  it("runs every panel through the panel query route and maps errors per panel", async () => {
    const server = setup("viewer");
    renderApp("/dashboards/d-sales");
    expect(await screen.findByRole("heading", { level: 1, name: "Sales" })).toBeTruthy();

    const orders = await waitFor(() => {
      const panel = panelOf("Orders");
      within(panel).getByText("9007199254740993");
      return panel;
    });
    expect(within(orders).getAllByRole("row").length).toBeGreaterThan(1);
    await waitFor(() =>
      within(panelOf("Slow")).getByText(/The query took too long and was stopped/),
    );
    // One failing query in a panel shows its error next to the data of the other.
    const mixed = panelOf("Mixed");
    await waitFor(() =>
      within(mixed).getByText(/Query B: .*rejected because it could change data/),
    );
    expect(within(mixed).getByText("Ada")).toBeTruthy();

    const calls = server.calls.filter((c) => c.path.includes("/panels/"));
    expect(calls.map((c) => c.path.split("/").at(-2)).sort()).toEqual([
      "p-mixed",
      "p-orders",
      "p-slow",
    ]);
    expect(
      server.calls.some((c) => c.path.endsWith("/query") && !c.path.includes("/panels/")),
    ).toBe(false);
    const body = calls[0]?.body as { timeRange: { from: number; to: number } };
    expect(typeof body.timeRange.from).toBe("number");
    expect(body.timeRange.to - body.timeRange.from).toBe(6 * 3_600_000);
  });

  it("gives viewers view mode only", async () => {
    setup("viewer");
    renderApp("/dashboards/d-sales");
    await screen.findByRole("heading", { level: 1, name: "Sales" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    expect(screen.getByRole("link", { name: "History" })).toBeTruthy();
  });

  it("changes the time range, and the queries follow with absolute times", async () => {
    const server = setup("viewer");
    const { user, location } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Time range: Last 6 hours" }));
    const dialog = screen.getByRole("dialog", { name: "Time range" });
    await user.click(within(dialog).getByRole("button", { name: "Last 15 minutes" }));
    expect(location().search).toMatchObject({ from: "now-15m", to: "now" });
    await waitFor(() => {
      const last = server.calls.filter((c) => c.path.includes("/panels/")).at(-1)?.body as
        | { timeRange: { from: number; to: number } }
        | undefined;
      const range = last?.timeRange ?? { from: 0, to: 0 };
      expect(range.to - range.from).toBe(15 * 60_000);
    });
  });

  it("limits parallel panel queries and drops the queued ones when leaving", async () => {
    const panels = Array.from({ length: 10 }, (_, i) =>
      sqlPanel(`p${i}`, `Panel ${i}`, "SELECT 1", (i % 2) * 12, Math.floor(i / 2) * 8),
    );
    const server = setup("viewer", panels);
    server.areas.dashboards.holdPanelQueries = true;
    const { user } = renderApp("/dashboards/d-sales");
    await screen.findByRole("heading", { level: 1, name: "Sales" });
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries).toHaveLength(PANEL_QUERY_CONCURRENCY),
    );
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await screen.findByRole("navigation", { name: "Folders" });
    server.areas.dashboards.release();
    // Give the queue every chance to start what was waiting; nothing more is sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.areas.dashboards.panelQueries).toHaveLength(PANEL_QUERY_CONCURRENCY);
  });
});

describe("editing a dashboard", () => {
  it("moves and resizes a panel with the keyboard and saves with a message", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const handle = within(panelOf("Orders")).getByRole("button", { name: "Arrange “Orders”" });
    handle.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Shift>}{ArrowRight}{/Shift}");
    expect(document.activeElement).toBe(
      within(panelOf("Orders")).getByRole("button", { name: "Arrange “Orders”" }),
    );
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.type(within(dialog).getByRole("textbox", { name: /What changed/ }), "Bigger orders");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(latest(server.areas.dashboards.dashboards[0] as never).version).toBe(2),
    );
    const saved = latest(server.areas.dashboards.dashboards[0] as never);
    expect(saved.message).toBe("Bigger orders");
    const orders = saved.model.panels.find((p) => p.id === "p-orders");
    expect(orders?.grid).toEqual({ x: 0, y: 2, w: 13, h: 8 });
    // The panel below was pushed down instead of being covered.
    expect(saved.model.panels.find((p) => p.id === "p-mixed")?.grid.y).toBe(10);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("adds a panel with a query from the panel editor", async () => {
    const server = setup("editor", []);
    const { user } = renderApp("/dashboards/d-sales");
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "Add panel" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Edit panel" });
    await user.type(within(dialog).getByRole("textbox", { name: "Panel title" }), "Revenue");
    await user.click(await within(dialog).findByRole("button", { name: "Add query" }));
    const editor = within(dialog).getByRole("textbox", { name: "Query A" });
    // Typed with fireEvent: the completion list would otherwise take Enter and Tab.
    fireEvent.change(editor, { target: { value: "SELECT amount FROM orders" } });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Format" }), "table");
    await user.click(within(dialog).getByRole("radio", { name: "Table" }));
    await user.click(within(dialog).getByRole("button", { name: "Run queries" }));
    expect(await within(dialog).findByText("Grace")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("article", { name: "Revenue" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(server.areas.dashboards.dashboards[0]?.versions).toHaveLength(2));
    const panel = latest(server.areas.dashboards.dashboards[0] as never).model.panels[0];
    expect(panel).toMatchObject({
      type: "table",
      title: "Revenue",
      targets: [
        {
          refId: "A",
          datasourceId: PG_ID,
          query: { sql: "SELECT amount FROM orders", format: "table" },
        },
      ],
    });
    // Unsaved panels were previewed with the free query route; viewers use the stored panel.
    expect(server.areas.datasources.queries.length).toBeGreaterThan(0);
  });

  it("adds a variable whose value reaches every panel query", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = screen.getByRole("dialog", { name: "Dashboard settings" });
    await user.click(within(dialog).getByRole("button", { name: "Add variable" }));
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "region");
    await user.type(within(dialog).getByRole("textbox", { name: "Values" }), "eu, us");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(storedSales(server).versions).toHaveLength(2));
    // Only the fields of a custom variable: the server refuses anything else.
    expect(latest(storedSales(server)).model.variables).toEqual([
      { name: "region", type: "custom", options: ["eu", "us"] },
    ]);

    await user.selectOptions(await screen.findByRole("combobox", { name: "region" }), "us");
    await waitFor(() => {
      const last = server.areas.dashboards.panelQueries.at(-1);
      expect(last?.body.variables).toEqual({ region: "us" });
    });
  });
  it("shows both sides of a version conflict and saves mine on request", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Remove “Slow”" }));

    // Someone else saves a renamed panel meanwhile.
    const stored = storedSales(server);
    const theirs = structuredClone(latest(stored).model);
    theirs.panels[0] = { ...(theirs.panels[0] as PanelModel), title: "Orders by day" };
    saveAsOther(stored, theirs);

    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    const conflict = await screen.findByRole("dialog", {
      name: "Someone else saved this dashboard",
    });
    const mine = within(conflict).getByRole("region", { name: "Your changes" });
    const others = within(conflict).getByRole("region", {
      name: "Saved by others in the meantime",
    });
    expect(within(mine).getByText("Panel “Slow” removed")).toBeTruthy();
    expect(within(others).getByText("Panel “Orders by day” changed")).toBeTruthy();

    await user.click(
      within(conflict).getByRole("button", { name: "Save mine as the newest version" }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(3));
    expect(latest(stored).model.panels.map((p) => p.id)).toEqual(["p-orders", "p-mixed"]);
  });

  it("can drop my changes and open the other version after a conflict", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Remove “Slow”" }));
    const stored = storedSales(server);
    const theirs = { ...structuredClone(latest(stored).model), title: "Sales 2027" };
    saveAsOther(stored, theirs);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    const conflict = await screen.findByRole("dialog", {
      name: "Someone else saved this dashboard",
    });
    await user.click(within(conflict).getByRole("button", { name: "Discard mine, open theirs" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sales 2027" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Slow" })).toBeTruthy();
    expect(stored.versions).toHaveLength(2);
  });
});

describe("history and trash", () => {
  it("restores an older version as the newest", async () => {
    const server = setup();
    const stored = storedSales(server);
    saveAsOther(stored, emptyModel("Sales"), "Removed everything");
    const { user } = renderApp("/dashboards/d-sales/versions");
    expect(await screen.findByText("Removed everything")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore…" }));
    const dialog = screen.getByRole("dialog", { name: "Restore this version?" });
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sales" })).toBeTruthy();
    expect(latest(stored)).toMatchObject({ version: 3, restoredFrom: 1, message: "" });
    expect(latest(stored).model.panels).toHaveLength(3);
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("moves a dashboard to the trash and restores it from there", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete dashboard?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Trash" })).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Restore “Sales”" }));
    await waitFor(() => expect(storedSales(server).deletedAt).toBeNull());
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
  });

  it("trashes a folder with its dashboards, restores it and purges for good", async () => {
    const server = setup("admin");
    const { user } = renderApp("/dashboards?folder=f-ops");
    await user.click(await screen.findByRole("button", { name: "Delete folder…" }));
    const confirm = screen.getByRole("dialog", { name: "Delete folder?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder “Operations” moved to the trash.")).toBeTruthy();
    expect(storedSales(server).deletedAt).not.toBeNull();

    await user.click(screen.getByRole("link", { name: "Trash" }));
    // The folder is listed; the dashboard trashed with it is listed as well.
    expect(await screen.findByRole("button", { name: "Restore “Operations”" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore “Operations”" }));
    await waitFor(() => expect(storedSales(server).deletedAt).toBeNull());

    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await user.click(await screen.findByRole("link", { name: "Sales" }));
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Delete dashboard?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Delete “Sales” for good" }));
    const purge = screen.getByRole("dialog", { name: "Delete for good?" });
    expect(document.activeElement).toBe(within(purge).getByRole("button", { name: "Cancel" }));
    await user.click(within(purge).getByRole("button", { name: "Delete for good" }));
    await waitFor(() =>
      expect(server.areas.dashboards.dashboards.some((d) => d.id === "d-sales")).toBe(false),
    );
  });
});

describe("performance budget", () => {
  const CI = process.env.CI !== undefined;

  it("renders a 20-panel dashboard with its data within budget", async () => {
    const panels = Array.from({ length: 20 }, (_, i) =>
      sqlPanel(`p${i}`, `Panel ${i}`, "SELECT 1", (i % 2) * 12, Math.floor(i / 2) * 8),
    );
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      setup("viewer", panels);
      const start = performance.now();
      const { view } = renderApp("/dashboards/d-sales");
      await waitFor(() => expect(screen.getAllByText("Grace")).toHaveLength(20), {
        timeout: 10_000,
      });
      best = Math.min(best, performance.now() - start);
      view.unmount();
    }
    process.stdout.write(`dashboard: 20 panels with data in ${best.toFixed(0)} ms (best of 3)\n`);
    expect(best).toBeLessThan(CI ? 3000 : 1500);
  });
});
