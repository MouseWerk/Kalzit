import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "./model";
import { addDashboard, addFolder, latest } from "./test/fakeDashboards";

/*
 * The dashboards page as the approved design draws it: one Import menu beside "New dashboard",
 * views with counts above the folder tree, a toolbar with search, tags, order and list or
 * tiles, and the dashboards opened last above "All dashboards".
 */

function setup(role = "editor") {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
  });
  const { dashboards } = server.areas;
  addFolder(dashboards, "f-sales", "Sales");
  addFolder(dashboards, "f-dach", "DACH", { parentId: "f-sales" });
  addFolder(dashboards, "f-ops", "Operations");
  const dated = (
    id: string,
    title: string,
    folderId: string | null,
    day: number,
    tags?: string[],
  ) => {
    const stored = addDashboard(
      dashboards,
      id,
      { ...emptyModel(title), ...(tags === undefined ? {} : { tags }) },
      { folderId },
    );
    latest(stored).createdAt = Date.UTC(2026, 9, day);
    return stored;
  };
  dated("d-revenue", "Revenue by region", "f-dach", 5, ["kpi", "month"]);
  dated("d-orders", "Orders live", "f-sales", 3, ["live"]);
  dated("d-load", "Server load", "f-ops", 9, ["kpi"]);
  dated("d-top", "Overview", null, 1);
  return server;
}

/** The dashboard links of the list, in order. */
function listedTitles(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the dashboards page", () => {
  it("counts all, favorites and every folder with its subfolders", async () => {
    const server = setup();
    server.areas.shell.stars.push({ dashboardId: "d-load", at: 1 });
    renderApp("/dashboards");
    const views = await screen.findByRole("navigation", { name: "Show dashboards" });
    expect(await within(views).findByRole("link", { name: "All dashboards 4" })).toBeTruthy();
    expect(within(views).getByRole("link", { name: "Favorites 1" })).toBeTruthy();
    expect(within(views).getByRole("link", { name: "Recently opened" })).toBeTruthy();
    expect(
      within(views).getByRole("link", { name: "All dashboards 4" }).getAttribute("aria-current"),
    ).toBe("page");
    const tree = screen.getByRole("navigation", { name: "Folders" });
    // Sales holds one dashboard itself and one in DACH below it.
    expect(await within(tree).findByRole("treeitem", { name: "Sales 2" })).toBeTruthy();
    expect(within(tree).getByRole("treeitem", { name: "DACH 1" })).toBeTruthy();
    expect(within(tree).getByRole("treeitem", { name: "Operations 1" })).toBeTruthy();
    // Playlists, library panels and the trash sit below, as links.
    const more = screen.getByRole("navigation", { name: "More for dashboards" });
    expect(
      within(more)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Playlists", "Library panels", "Trash"]);
  });

  it("shows the favorites and stars a dashboard from its row", async () => {
    const server = setup();
    server.areas.shell.stars.push({ dashboardId: "d-load", at: 1 });
    const { user, location } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Orders live" });
    const star = screen.getByRole("button", { name: "Favorite “Orders live”" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await user.click(star);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Favorite “Orders live”" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(server.areas.shell.stars.map((s) => s.dashboardId)).toContain("d-orders");

    await user.click(await screen.findByRole("link", { name: "Favorites 2" }));
    await waitFor(() => expect(location().search).toEqual({ view: "starred" }));
    await waitFor(() => expect(listedTitles()).toEqual(["Server load", "Orders live"]));
    expect(screen.getByRole("heading", { level: 2, name: "Favorites" })).toBeTruthy();
  });

  it("holds both imports in one Import menu next to New dashboard", async () => {
    setup();
    const { user, location } = renderApp("/dashboards?folder=f-ops");
    const importMenu = await screen.findByRole("button", { name: "Import" });
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeTruthy();
    // The old separate buttons are gone.
    expect(screen.queryByRole("link", { name: "Import from Grafana" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import…" })).toBeNull();

    await user.click(importMenu);
    const menu = await screen.findByRole("menu", { name: "Import" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Import from Grafana", "Import…"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Import…" }));
    expect(await screen.findByRole("dialog", { name: "Import dashboard" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Import" }));
    await user.click(await screen.findByRole("menuitem", { name: "Import from Grafana" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/import/grafana"));
    expect(location().search).toEqual({ folder: "f-ops" });
  });

  it("offers no import or new dashboard without the right to create one", async () => {
    setup("viewer");
    renderApp("/dashboards");
    await screen.findByRole("link", { name: "Orders live" });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New dashboard" })).toBeNull();
  });

  it("sorts by last change, by name and by last opened", async () => {
    const server = setup();
    const { user, location } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Orders live" });
    // Newest change first by default.
    expect(listedTitles()).toEqual(["Server load", "Revenue by region", "Orders live", "Overview"]);
    expect(server.calls.some((c) => c.path.includes("sort=updated"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Sort: Last changed" }));
    const menu = await screen.findByRole("menu", { name: "Sort: Last changed" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["Last changed", "Name", "Last opened"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Name" }));
    await waitFor(() => expect(location().search).toEqual({ sort: "title" }));
    await waitFor(() =>
      expect(listedTitles()).toEqual([
        "Orders live",
        "Overview",
        "Revenue by region",
        "Server load",
      ]),
    );

    server.areas.shell.views.push(
      { dashboardId: "d-top", at: 2 },
      { dashboardId: "d-orders", at: 1 },
    );
    await user.click(screen.getByRole("button", { name: "Sort: Name" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Last opened" }));
    await waitFor(() =>
      expect(listedTitles()).toEqual([
        "Overview",
        "Orders live",
        "Server load",
        "Revenue by region",
      ]),
    );
  });

  it("filters by tag and searches folder names and tags too", async () => {
    setup();
    const { user, location } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Orders live" });
    await user.click(screen.getByRole("button", { name: "Tags" }));
    const menu = await screen.findByRole("menu", { name: "Tags" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual(["All tags", "kpi", "live", "month"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "kpi" }));
    await waitFor(() => expect(location().search).toEqual({ tag: "kpi" }));
    await waitFor(() => expect(listedTitles()).toEqual(["Server load", "Revenue by region"]));
    expect(screen.getByRole("button", { name: "Tag “kpi”" })).toBeTruthy();

    // A search that, with the tag, finds nothing says so and clears both.
    await user.type(screen.getByRole("searchbox", { name: "Search dashboards" }), "orders");
    expect(await screen.findByRole("heading", { name: "No matching dashboards" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(location().search).toEqual({}));

    await user.type(screen.getByRole("searchbox", { name: "Search dashboards" }), "dach");
    await waitFor(() => expect(listedTitles()).toEqual(["Revenue by region"]));
  });

  it("shows tiles with a layout sketch and remembers the choice per person", async () => {
    const server = setup();
    const stored = server.areas.dashboards.dashboards.find((d) => d.id === "d-load");
    if (stored === undefined) throw new Error("no dashboard");
    latest(stored).model.panels = [
      {
        id: "p1",
        type: "timeseries",
        title: "CPU",
        grid: { x: 0, y: 0, w: 12, h: 8 },
        targets: [],
        transformations: [],
        options: {},
        fieldConfig: {},
      },
    ];
    const { user } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Orders live" });
    const display = screen.getByRole("group", { name: "Display" });
    expect(within(display).getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(within(display).getByRole("button", { name: "Tiles" }));
    expect(
      within(display).getByRole("button", { name: "Tiles" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() => expect(document.querySelectorAll(".dashboard-tile")).toHaveLength(4));
    const tiles = document.querySelector(".dashboard-tiles") as HTMLElement;
    expect(within(tiles).getByRole("link", { name: "Server load" })).toBeTruthy();
    expect(server.calls.some((c) => c.path.includes("layout=true"))).toBe(true);
    // The sketch draws the panel where it sits, without anything it shows.
    const tile = within(tiles).getByRole("link", { name: "Server load" }).closest("li");
    expect(tile?.querySelectorAll("svg rect").length).toBeGreaterThan(0);
    expect(tile?.textContent).not.toContain("CPU");
    expect(window.localStorage.getItem(`kalzit.dashboardsDisplay.${TEST_USER.id}`)).toBe("tiles");

    cleanup();
    renderApp("/dashboards");
    const again = await screen.findByRole("group", { name: "Display" });
    expect(within(again).getByRole("button", { name: "Tiles" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows up to four recently opened dashboards above All dashboards only", async () => {
    const server = setup();
    server.areas.shell.views.push(
      { dashboardId: "d-top", at: 5 },
      { dashboardId: "d-load", at: 4 },
      { dashboardId: "d-orders", at: 3 },
      { dashboardId: "d-revenue", at: 2 },
    );
    addDashboard(server.areas.dashboards, "d-extra", emptyModel("Extra"));
    server.areas.shell.views.push({ dashboardId: "d-extra", at: 1 });
    const { user } = renderApp("/dashboards");
    const recent = await screen.findByRole("region", { name: "Recently opened" });
    await waitFor(() =>
      expect(
        within(recent)
          .getAllByRole("link")
          .map((link) => link.getAttribute("href")),
      ).toEqual([
        "/dashboards/d-top",
        "/dashboards/d-load",
        "/dashboards/d-orders",
        "/dashboards/d-revenue",
      ]),
    );
    // A folder shows its own dashboards alone.
    const tree = screen.getByRole("navigation", { name: "Folders" });
    await user.click(within(tree).getByRole("treeitem", { name: /^Operations/ }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Recently opened" })).toBeNull(),
    );
  });

  it("explains an empty favorites view", async () => {
    setup();
    renderApp("/dashboards?view=starred");
    expect(await screen.findByRole("heading", { name: "No favorites yet" })).toBeTruthy();
  });
});
