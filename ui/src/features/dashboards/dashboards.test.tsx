import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { mayManageAccess } from "./accessIntegration";
import { fetchDashboards } from "./api";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { PANEL_QUERY_CONCURRENCY } from "./queryQueue";
import { addDashboard, addFolder, latest, type StoredDashboard } from "./test/fakeDashboards";

/** Fills a field at once: typing key by key is slow, and these tests check what is sent. */
async function fill(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function sqlPanel(id: string, title: string, sql: string, x = 0, y = 0): PanelModel {
  return {
    id,
    type: "table",
    title,
    grid: { x, y, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: PG_ID, query: { sql } }],
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
          { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1" } },
          {
            refId: "B",
            datasourceId: PG_ID,
            query: { sql: "-- fail:query_rejected" },
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
  it("marks restricted folders for those who see them, subfolders included", async () => {
    const server = setup("admin");
    addFolder(server.areas.dashboards, "f-pay", "Payroll", { parentId: "f-hr" });
    const { user } = renderApp("/dashboards");
    const tree = await screen.findByRole("navigation", { name: "Folders" });
    expect(await within(tree).findByRole("button", { name: "People, Restricted" })).toBeTruthy();
    expect(within(tree).getByRole("button", { name: "Operations" })).toBeTruthy();
    // The subfolder inherits the restriction and shows it.
    expect(within(tree).getByRole("button", { name: "Payroll, Restricted" })).toBeTruthy();
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
    // Sent without a time range, so the server applies the organization's default.
    expect(server.areas.dashboards.createdWithoutRange).toEqual(["Capacity"]);
    const post = server.calls.find((c) => c.method === "POST" && c.path.endsWith("/dashboards"));
    expect(post?.body).not.toHaveProperty(["model", "timeRange"]);
    const created = server.areas.dashboards.dashboards.at(-1);
    expect(created === undefined ? "" : latest(created).model.title).toBe("Capacity");
  });

  it("lets a viewer with a write grant on a folder create a dashboard there", async () => {
    const server = setup("viewer");
    server.areas.dashboards.grants["f-ops"] = { write: true };
    const { user } = renderApp("/dashboards");
    await screen.findByRole("heading", { name: "All dashboards" });
    // At the top level the viewer role decides: nothing to create.
    expect(screen.queryByRole("button", { name: "New dashboard" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Operations" }));
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    const dialog = screen.getByRole("dialog", { name: "New dashboard" });
    await user.type(within(dialog).getByRole("textbox", { name: "Title" }), "Capacity");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Capacity" })).toBeTruthy();
    expect(server.areas.dashboards.dashboards.at(-1)?.folderId).toBe("f-ops");
  });
});

describe("dashboard view", () => {
  it("runs every panel through the panel query route and maps errors per panel", async () => {
    const server = setup("viewer");
    renderApp("/dashboards/d-sales");
    expect(await screen.findByRole("heading", { level: 1, name: "Sales" })).toBeTruthy();

    const orders = await waitFor(() => {
      const panel = panelOf("Orders");
      within(panel).getByText("9,007,199,254,740,993");
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

  it("opens edit mode from ?edit=true only for those who may edit", async () => {
    setup("viewer");
    const { location } = renderApp("/dashboards/d-sales?edit=true");
    await screen.findByRole("heading", { level: 1, name: "Sales" });
    await waitFor(() => expect(location().search).not.toHaveProperty("edit"));
    expect(screen.queryByRole("button", { name: "Add panel" })).toBeNull();
  });

  it("asks the options route only with the variables a query mentions, and not as time passes", async () => {
    const server = setup("viewer", []);
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "country", type: "custom", options: ["at", "de"] },
        { name: "unit", type: "custom", options: ["eur", "usd"] },
        {
          name: "city",
          type: "query",
          datasourceId: PG_ID,
          query: { sql: "SELECT city FROM shops WHERE country = $country" },
        },
      ],
    };
    server.areas.dashboards.variableOptions.city = [{ value: "graz", label: "Graz" }];
    const { user } = renderApp("/dashboards/d-sales");
    await screen.findByRole("option", { name: "Graz" });
    const requests = server.areas.dashboards.variableRequests;
    expect(requests).toHaveLength(1);
    // Its own name is left out, and so is a variable the query does not mention.
    expect(requests[0]?.body.variables).toEqual({ country: "at" });

    await user.selectOptions(screen.getByRole("combobox", { name: "unit" }), "usd");
    await user.selectOptions(screen.getByRole("combobox", { name: "country" }), "de");
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.body.variables).toEqual({ country: "de" });

    // Only "Refresh" or a new range reads them again.
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requests).toHaveLength(3));
  });

  it("offers custom options stored as value and label, and opens with the first", async () => {
    const server = setup("viewer");
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        {
          name: "region",
          type: "custom",
          options: [
            { value: "eu", label: "Europe" },
            { value: "us", label: "United States" },
          ],
        },
      ],
    };
    const { user } = renderApp("/dashboards/d-sales");
    const select = await screen.findByRole("combobox", { name: "region" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Europe", "United States"]);
    expect(select).toHaveProperty("value", "eu");
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.at(-1)?.body.variables).toEqual({
        region: "eu",
      }),
    );
    await user.selectOptions(select, "us");
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.at(-1)?.body.variables).toEqual({
        region: "us",
      }),
    );
  });

  it("opens a query variable without a stored value with its first option", async () => {
    const server = setup("viewer", []);
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "city", type: "query", datasourceId: PG_ID, query: { sql: "SELECT city" } },
      ],
    };
    server.areas.dashboards.variableOptions.city = [
      { value: "graz", label: "Graz" },
      { value: "linz", label: "Linz" },
    ];
    renderApp("/dashboards/d-sales");
    const select = await screen.findByRole("combobox", { name: "city" });
    await waitFor(() => expect(select).toHaveProperty("value", "graz"));
    // The placeholder for "no value" is gone once a value is chosen.
    expect(within(select).queryByRole("option", { name: "No value" })).toBeNull();
  });

  it("keeps the values a viewer picked when the dashboard is saved", async () => {
    const server = setup("editor");
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [{ name: "region", type: "custom", options: ["eu", "us"] }],
    };
    const { user } = renderApp("/dashboards/d-sales");
    await user.selectOptions(await screen.findByRole("combobox", { name: "region" }), "us");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Remove “Slow”" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(storedSales(server).versions).toHaveLength(2));
    // The new version opens a fresh view; the pick survives it.
    await screen.findByRole("button", { name: "Edit" });
    expect(screen.getByRole("combobox", { name: "region" })).toHaveProperty("value", "us");
  });

  it("runs a changed query variable through the free query route in edit mode", async () => {
    const server = setup("editor", []);
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "city", type: "query", datasourceId: PG_ID, query: { sql: "SELECT city FROM a" } },
      ],
    };
    server.areas.dashboards.variableOptions.city = [{ value: "graz", label: "Graz" }];
    const { user } = renderApp("/dashboards/d-sales");
    await screen.findByRole("option", { name: "Graz" });
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = screen.getByRole("dialog", { name: "Dashboard settings" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT name, score FROM customers" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    // The fake answers that SQL with a table whose first field is ids and second names.
    expect(await screen.findByRole("option", { name: "Ada" })).toBeTruthy();
    expect(server.areas.dashboards.variableRequests).toHaveLength(1);
    expect(server.areas.datasources.queries.at(-1)).toMatchObject({
      queries: [{ refId: "A", query: { sql: "SELECT name, score FROM customers" } }],
    });
  });

  it("says when there are more options than the answer lists", async () => {
    const server = setup("viewer", []);
    latest(storedSales(server)).model = {
      ...latest(storedSales(server)).model,
      variables: [
        { name: "city", type: "query", datasourceId: PG_ID, query: { sql: "SELECT city FROM a" } },
      ],
    };
    server.areas.dashboards.variableOptions.city = [{ value: "graz", label: "Graz" }];
    server.areas.dashboards.truncatedOptions.push("city");
    renderApp("/dashboards/d-sales");
    expect(await screen.findByText(/More values exist than are listed/)).toBeTruthy();
  });

  it("explains a variable the saved dashboard does not have", async () => {
    const server = setup("viewer", []);
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "city", type: "query", datasourceId: PG_ID, query: { sql: "SELECT city FROM a" } },
      ],
    };
    server.failNext("/api/orgs/o1/dashboards/d-sales/variables/city/options", 404, "not_found");
    renderApp("/dashboards/d-sales");
    expect(
      await screen.findByText(/This variable is not part of the saved dashboard/),
    ).toBeTruthy();
  });

  it("reads query variable options from the options route", async () => {
    const server = setup("viewer", []);
    const stored = storedSales(server);
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        {
          name: "region",
          type: "query",
          datasourceId: PG_ID,
          query: { sql: "SELECT r, n FROM t" },
        },
        { name: "tenant", type: "constant", query: { keep: true }, current: ["a", "b"] },
      ],
    };
    server.areas.dashboards.variableOptions.region = [
      { value: "eu", label: "Europe" },
      { value: "us", label: "United States" },
    ];
    renderApp("/dashboards/d-sales");
    const select = await screen.findByRole("combobox", { name: "region" });
    expect(await within(select).findByRole("option", { name: "United States" })).toBeTruthy();
    // A constant has nothing to choose and is not shown.
    expect(screen.queryByRole("combobox", { name: "tenant" })).toBeNull();
    // Nor is it sent: the server answers 422 for a constant's value in a stored query.
    const options = server.calls.filter((call) => call.path.includes("/variables/region/options"));
    expect(options.length).toBeGreaterThan(0);
    for (const call of options) {
      expect(JSON.stringify(call.body)).not.toContain("tenant");
    }
  });

  it.each([
    [403, "forbidden", "You do not have permission for this."],
    [500, "internal", /Something went wrong on the server/],
  ] as const)(
    "shows a failed panel request (%i) as an error, not as a panel without a query",
    async (status, code, text) => {
      const server = setup("viewer");
      server.failNext("/api/orgs/o1/dashboards/d-sales/panels/p-orders/query", status, code);
      renderApp("/dashboards/d-sales");
      await screen.findByRole("heading", { level: 1, name: "Sales" });
      const orders = await waitFor(() => panelOf("Orders"));
      expect(await within(orders).findByText(text)).toBeTruthy();
      expect(within(orders).queryByText("This panel has no query yet.")).toBeNull();
    },
  );

  it("asks for every stored target, also an empty one, and shows what the server says", async () => {
    const panel = {
      ...sqlPanel("p-two", "Two", "SELECT 1"),
      targets: [
        { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1" } },
        { refId: "B", datasourceId: PG_ID, query: { sql: "" } },
      ],
    };
    setup("viewer", [panel]);
    renderApp("/dashboards/d-sales");
    const two = await waitFor(() => panelOf("Two"));
    expect(await within(two).findByText(/Query B: .*rejected/)).toBeTruthy();
    expect(within(two).getByText("Ada")).toBeTruthy();
  });

  it("draws a panel after its stored steps and names a failing step", async () => {
    setup("viewer", [
      {
        ...sqlPanel("p-steps", "Scores", "SELECT * FROM scores"),
        transformations: [
          { id: "s1", type: "calculate", frame: "A", name: "doubled", expression: "score * 2" },
        ],
      },
      {
        ...sqlPanel("p-broken", "Broken", "SELECT * FROM scores", 12, 0),
        transformations: [
          { id: "s1", type: "calculate", frame: "A", name: "x", expression: "name * 2" },
        ],
      },
    ]);
    renderApp("/dashboards/d-sales");
    const scores = await waitFor(() => {
      const panel = panelOf("Scores");
      within(panel).getByRole("columnheader", { name: "doubled" });
      return panel;
    });
    expect(within(scores).getByText("6")).toBeTruthy();
    const broken = await waitFor(() => {
      const panel = panelOf("Broken");
      within(panel).getByText(/Step 1:/);
      return panel;
    });
    expect(within(broken).getByText(/Step 1:/).textContent).toMatch(
      /Step 1: “\*” cannot combine text and number/,
    );
    // The queries' own result still shows.
    expect(within(broken).getByText("Ada")).toBeTruthy();
  });

  it("offers export only with data:export and asks the panel's export route", async () => {
    setup("viewer");
    renderApp("/dashboards/d-sales");
    await waitFor(() => within(panelOf("Orders")).getByText("9,007,199,254,740,993"));
    expect(screen.queryByRole("button", { name: "Export Orders" })).toBeNull();
    cleanup();

    const server = setup("editor");
    // jsdom has no object URLs; they are put in for this test and taken out again after it.
    const before = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = () => "blob:kalzit";
    URL.revokeObjectURL = () => {};
    const created = vi.spyOn(URL, "createObjectURL");
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    onTestFinished(() => {
      created.mockRestore();
      clicked.mockRestore();
      URL.createObjectURL = before.create;
      URL.revokeObjectURL = before.revoke;
    });
    const { user } = renderApp("/dashboards/d-sales");
    const orders = await waitFor(() => {
      const panel = panelOf("Orders");
      within(panel).getByText("9,007,199,254,740,993");
      return panel;
    });
    await user.click(within(orders).getByRole("button", { name: "Export Orders" }));
    const dialog = screen.getByRole("dialog", { name: "Export data" });
    await user.click(within(dialog).getByRole("radio", { name: /German/ }));
    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(clicked).toHaveBeenCalled());
    expect(server.areas.dashboards.panelExports).toHaveLength(1);
    expect(server.areas.dashboards.panelExports[0]).toMatchObject({
      panelId: "p-orders",
      body: { format: "csv", language: "de" },
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Export data" })).toBeNull();
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
    const before = server.areas.datasources.queries.length;
    const handle = within(panelOf("Orders")).getByRole("button", { name: "Arrange “Orders”" });
    handle.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Shift>}{ArrowRight}{/Shift}");
    expect(document.activeElement).toBe(
      within(panelOf("Orders")).getByRole("button", { name: "Arrange “Orders”" }),
    );
    // Moving by keyboard is announced.
    expect(screen.getByText("Orders: column 1, row 3, 13 columns wide, 8 rows high.")).toBeTruthy();
    // Moving panels does not change their queries: they stay on the panel route.
    expect(server.areas.datasources.queries.length).toBe(before);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await fill(
      user,
      within(dialog).getByRole("textbox", { name: /What changed/ }),
      "Bigger orders",
    );
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

  it("puts Done where Edit was, so a second click there does not add a panel", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-sales");
    const edit = await screen.findByRole("button", { name: "Edit" });
    const tools = edit.parentElement as HTMLElement;
    const position = [...tools.children].indexOf(edit);
    await user.click(edit);
    const done = await screen.findByRole("button", { name: "Done" });
    expect([...tools.children].indexOf(done)).toBe(position);
    expect(within(tools).getByRole("button", { name: "Add panel" })).not.toBe(
      tools.children[position],
    );
  });

  it("adds a panel with a query from the panel editor", async () => {
    const server = setup("editor", []);
    const { user } = renderApp("/dashboards/d-sales");
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "Add panel" })[0] as HTMLElement);
    const dialog = await screen.findByRole("region", { name: "Edit panel" });
    await user.type(within(dialog).getByRole("textbox", { name: "Panel title" }), "Revenue");
    await user.click(await within(dialog).findByRole("button", { name: "Add query" }));
    const editor = within(dialog).getByRole("textbox", { name: "Query A" });
    // Typed with fireEvent: the completion list would otherwise take Enter and Tab.
    fireEvent.change(editor, { target: { value: "SELECT amount FROM orders" } });
    await user.click(within(dialog).getByRole("radio", { name: "Table" }));
    await user.click(within(dialog).getByRole("button", { name: "Run queries" }));
    expect(await within(dialog).findByText("Grace")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Back to dashboard" }));

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
          query: { sql: "SELECT amount FROM orders" },
        },
      ],
    });
    // Unsaved panels were previewed with the free query route; viewers use the stored panel.
    expect(server.areas.datasources.queries.length).toBeGreaterThan(0);
  });

  it("keeps each panel type's options while stepping through the picker", async () => {
    setup("editor", []);
    const { user } = renderApp("/dashboards/d-sales");
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement);
    await user.click(screen.getAllByRole("button", { name: "Add panel" })[0] as HTMLElement);
    const dialog = await screen.findByRole("region", { name: "Edit panel" });
    await user.click(within(dialog).getByRole("radio", { name: "Stat" }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Color" }), "background");
    // Arrow keys in the radio group pass through other types; coming back restores the options.
    await user.click(within(dialog).getByRole("radio", { name: "Gauge" }));
    await user.click(within(dialog).getByRole("radio", { name: "Stat" }));
    expect(
      (within(dialog).getByRole("combobox", { name: "Color" }) as HTMLSelectElement).value,
    ).toBe("background");
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
    await fill(user, name, "region");
    await fill(user, within(dialog).getByRole("textbox", { name: "Values" }), "eu, us");
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
    const saveDialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await fill(user, within(saveDialog).getByRole("textbox", { name: /What changed/ }), "No slow");
    const reads = () =>
      server.calls.filter((c) => c.method === "GET" && c.path.endsWith("/d-sales"));
    const readsBefore = reads().length;
    await user.click(within(saveDialog).getByRole("button", { name: "Save" }));
    const conflict = await screen.findByRole("dialog", {
      name: "Someone else saved this dashboard",
    });
    // The stored version came with the 409 answer; it is not read again.
    expect(reads().length).toBe(readsBefore);
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
    // The message typed for the save is kept for the overwrite.
    expect(latest(stored).message).toBe("No slow");
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

describe("rights and refusals", () => {
  it("lets a viewer with an edit grant edit and save, but not delete", async () => {
    const server = setup("viewer", []);
    server.areas.dashboards.grants["d-sales"] = { write: true };
    const { user } = renderApp("/dashboards/d-sales");
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0] as HTMLElement);
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = screen.getByRole("dialog", { name: "Dashboard settings" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await fill(user, title, "Sales (granted)");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(storedSales(server).versions).toHaveLength(2));
    expect(latest(storedSales(server)).model.title).toBe("Sales (granted)");
  });

  it.each([
    ["a data source the editor may not query", "forbidden", /data source you may not query/],
    ["a data source that no longer exists", "missing", /no longer exists/],
  ] as const)("explains a save refused for %s", async (_, kind, text) => {
    const server = setup("editor");
    if (kind === "forbidden") {
      server.areas.dashboards.unqueryable.push(PG_ID);
    } else {
      const source = server.areas.datasources.datasources.find((d) => d.id === PG_ID);
      if (source !== undefined) {
        source.deletedAt = Date.now();
      }
    }
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    // A copy is a new query on the source, which the save checks.
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Duplicate “Slow”" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
    expect(storedSales(server).versions).toHaveLength(1);
  });

  it("lets an edit grant without query rights restyle a panel and preview its saved queries", async () => {
    const server = setup("viewer");
    server.areas.dashboards.grants["d-sales"] = { write: true };
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Orders")).getByRole("button", { name: "Edit “Orders”" }));
    const editor = await screen.findByRole("region", { name: "Edit panel" });
    // The stored query shows as text, with what changing it would need.
    expect(within(editor).getByText("SELECT * FROM orders")).toBeTruthy();
    expect(within(editor).getByText(/needs query rights on its data source/)).toBeTruthy();
    expect(within(editor).queryByText(/no data source/i)).toBeNull();
    expect(within(editor).queryByRole("button", { name: "Add query" })).toBeNull();
    // The preview runs the saved panel through its route, never the free query route.
    const free = server.areas.datasources.queries.length;
    await user.click(within(editor).getByRole("button", { name: "Run queries" }));
    await waitFor(() =>
      expect(server.areas.dashboards.panelQueries.some((q) => q.panelId === "p-orders")).toBe(true),
    );
    expect(server.areas.datasources.queries.length).toBe(free);
  });

  it("saves a rename without rights on the dashboard's sources", async () => {
    // No query right on the source: unchanged queries are not checked again.
    const server = setup("editor");
    server.areas.dashboards.unqueryable.push(PG_ID);
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Remove “Slow”" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(storedSales(server).versions).toHaveLength(2));
  });

  it("checks every query again when a variable changes", async () => {
    const server = setup("editor");
    server.areas.dashboards.unqueryable.push(PG_ID);
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const settings = screen.getByRole("dialog", { name: "Dashboard settings" });
    await user.click(within(settings).getByRole("button", { name: "Add variable" }));
    await user.click(within(settings).getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/data source you may not query/)).toBeTruthy();
  });

  it("answers an unseen source as a model problem, not as a refusal", async () => {
    const server = setup("viewer");
    server.areas.dashboards.grants["d-sales"] = { write: true };
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Duplicate “Slow”" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/no longer exists/)).toBeTruthy();
  });

  it("shows the server's own message for other refusals of the model", async () => {
    const server = setup("editor");
    server.failNext("/api/orgs/o1/dashboards/d-sales", 422, "validation", "PUT", "model");
    const { user } = renderApp("/dashboards/d-sales");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(within(panelOf("Slow")).getByRole("button", { name: "Remove “Slow”" }));
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "The server did not accept the dashboard: server message for validation",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/no longer exists/)).toBeNull();
  });

  it("follows the resource's own right to manage access", () => {
    const has = (permission: string) => permission === "dashboards:share";
    expect(mayManageAccess("dashboard", undefined, { has })).toBe(true);
    expect(mayManageAccess("dashboard", false, { has })).toBe(false);
    expect(mayManageAccess("folder", true, { has })).toBe(true);
    expect(mayManageAccess("folder", undefined, { has })).toBe(false);
  });

  it.each([
    ["dashboard", "/dashboards/d-sales", "Access to “Sales”"],
    ["folder", "/dashboards?folder=f-ops", "Access to “Operations”"],
    ["data source", `/data-sources/${PG_ID}`, "Access to “Sales DB”"],
  ])("opens the access dialog for a %s", async (_, path, title) => {
    setup("admin");
    const { user } = renderApp(path);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    expect(await screen.findByRole("dialog", { name: title })).toBeTruthy();
  });

  it("offers no access dialog to a viewer without the right to share", async () => {
    setup("viewer");
    renderApp("/dashboards/d-sales");
    await screen.findByRole("heading", { level: 1, name: "Sales" });
    expect(screen.queryByRole("button", { name: "Access…" })).toBeNull();
  });

  it("passes the query's abort signal to the request", async () => {
    installFakeServer({ signedIn: true, user: asRole("viewer") });
    const controller = new AbortController();
    await fetchDashboards("o1", {}, controller.signal);
    const init = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(init?.signal).toBe(controller.signal);
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

  it("lists a trashed dashboard even when its folder is not in the caller's list", async () => {
    const server = setup("editor");
    const lost = addDashboard(server.areas.dashboards, "d-lost", emptyModel("Elsewhere"), {
      folderId: "f-not-listed",
    });
    lost.deletedAt = Date.now();
    renderApp("/dashboards/trash");
    expect(await screen.findByRole("button", { name: "Restore “Elsewhere”" })).toBeTruthy();
  });

  it("lists a dashboard trashed alone even at the moment a folder was trashed", async () => {
    const server = setup("admin");
    const at = Date.now() - 1000;
    const folder = addFolder(server.areas.dashboards, "f-old", "Old");
    folder.deletedAt = at;
    // In a live folder, trashed on its own at the same millisecond.
    storedSales(server).deletedAt = at;
    renderApp("/dashboards/trash");
    expect(await screen.findByRole("button", { name: "Restore “Old”" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore “Sales”" })).toBeTruthy();
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
    // One subtree is one entry: the folder, not the dashboard that went with it.
    expect(await screen.findByRole("button", { name: "Restore “Operations”" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore “Sales”" })).toBeNull();
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
