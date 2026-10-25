import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "./model";
import { addDashboard, addFolder } from "./test/fakeDashboards";

function setup() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  const { dashboards } = server.areas;
  addFolder(dashboards, "f-sales", "Sales");
  addFolder(dashboards, "f-regions", "Regions", { parentId: "f-sales" });
  addFolder(dashboards, "f-north", "North", { parentId: "f-regions" });
  addFolder(dashboards, "f-ops", "Operations");
  addFolder(dashboards, "f-zeta", "Zeta");
  addDashboard(dashboards, "d-north", emptyModel("North overview"), { folderId: "f-north" });
  return server;
}

const KEY = `kalzit.folderTree.${TEST_USER.id}`;
const tree = () => screen.findByRole("tree", { name: "Folders" });

afterEach(() => window.localStorage.clear());

describe("the folder tree", () => {
  it("is a tree with levels, one tab stop and the current folder selected", async () => {
    setup();
    renderApp("/dashboards?folder=f-regions");
    const nav = await tree();
    const regions = await within(nav).findByRole("treeitem", { name: "Regions" });
    expect(regions.getAttribute("aria-level")).toBe("2");
    expect(regions.getAttribute("aria-selected")).toBe("true");
    expect(within(nav).getByRole("treeitem", { name: "North" }).getAttribute("aria-level")).toBe(
      "3",
    );
    expect(within(nav).getAllByRole("group").length).toBeGreaterThan(0);
    // Only the current entry is in the tab order.
    const stops = within(nav)
      .getAllByRole("treeitem")
      .filter((item) => item.tabIndex === 0);
    expect(stops).toEqual([regions]);
    // The chevrons are for the pointer only: nothing focusable is hidden.
    expect(nav.querySelectorAll('[aria-hidden="true"] button, button[aria-hidden]')).toHaveLength(
      0,
    );
  });

  it("folds and opens folders with the arrow keys and says whether they are open", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const nav = await tree();
    const sales = await within(nav).findByRole("treeitem", { name: "Sales" });
    expect(sales.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(nav).getByRole("treeitem", { name: "Operations" }).hasAttribute("aria-expanded"),
    ).toBe(false);
    sales.focus();
    await user.keyboard("{ArrowLeft}");
    expect(sales.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("treeitem", { name: "Regions" })).toBeNull();
    // Down skips what is folded.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(nav).getByRole("treeitem", { name: "Zeta" }));
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(sales.getAttribute("aria-expanded")).toBe("true");
    // Right on an open folder moves into it; Left on a child moves back to its parent.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(nav).getByRole("treeitem", { name: "Regions" }));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(sales);
    // Enter opens the folder.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(sales.getAttribute("aria-selected")).toBe("true"));
  });

  it("moves focus to the folder that folded away the focused entry", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const nav = await tree();
    const regions = await within(nav).findByRole("treeitem", { name: "Regions" });
    const north = within(nav).getByRole("treeitem", { name: "North" });
    north.focus();
    // Folding the section that holds the focus moves it to the folder that was folded.
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(regions);
    north.focus();
    await user.click(screen.getByRole("button", { name: "Fold all" }));
    // Fold all keeps the focus on its button; the tree's tab stop moves to the top folder.
    const sales = within(nav).getByRole("treeitem", { name: "Sales" });
    await waitFor(() => expect(sales.tabIndex).toBe(0));
  });
  it("remembers what is folded for this account and folds all at once", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const nav = await tree();
    await within(nav).findByRole("treeitem", { name: "North" });
    await user.click(screen.getByRole("button", { name: "Fold all" }));
    expect(within(nav).queryByRole("treeitem", { name: "Regions" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fold all" })).toHaveProperty("disabled", true);
    cleanup();
    renderApp("/dashboards");
    const again = await tree();
    expect(
      (await within(again).findByRole("treeitem", { name: "Sales" })).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(window.localStorage.getItem(KEY)).toContain("f-sales");
  });

  it("keeps the way to the current folder open and forgets folders that are gone", async () => {
    setup();
    window.localStorage.setItem(KEY, JSON.stringify(["f-sales", "f-regions", "f-deleted"]));
    renderApp("/dashboards?folder=f-north");
    const nav = await tree();
    const north = await within(nav).findByRole("treeitem", { name: "North" });
    expect(north.getAttribute("aria-selected")).toBe("true");
    expect(within(nav).getByRole("treeitem", { name: "Sales" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem(KEY) ?? "[]")).toEqual([
        "f-sales",
        "f-regions",
      ]),
    );
  });
});
