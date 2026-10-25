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

const tree = () => screen.findByRole("navigation", { name: "Folders" });

afterEach(() => window.localStorage.clear());

describe("the folder tree", () => {
  it("folds and opens folders with the arrow keys and says whether they are open", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const nav = await tree();
    const sales = await within(nav).findByRole("button", { name: "Sales" });
    expect(sales.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(nav).getByRole("button", { name: "Operations" }).hasAttribute("aria-expanded"),
    ).toBe(false);
    sales.focus();
    await user.keyboard("{ArrowLeft}");
    expect(sales.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("button", { name: "Regions" })).toBeNull();
    // Down skips what is folded.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(nav).getByRole("button", { name: "Zeta" }));
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(sales.getAttribute("aria-expanded")).toBe("true");
    // Right on an open folder moves into it; Left on a child moves back to its parent.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(nav).getByRole("button", { name: "Regions" }));
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(document.activeElement).toBe(sales);
  });

  it("remembers what is folded for this account and folds all at once", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const nav = await tree();
    await within(nav).findByRole("button", { name: "North" });
    await user.click(within(nav).getByRole("button", { name: "Fold all" }));
    expect(within(nav).queryByRole("button", { name: "Regions" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Fold all" })).toHaveProperty("disabled", true);
    cleanup();
    renderApp("/dashboards");
    const again = await tree();
    expect(
      (await within(again).findByRole("button", { name: "Sales" })).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(window.localStorage.getItem(`kalzit.folderTree.${TEST_USER.id}`)).toContain("f-sales");
  });

  it("keeps the way to the current folder open, even when it was folded", async () => {
    setup();
    window.localStorage.setItem(
      `kalzit.folderTree.${TEST_USER.id}`,
      JSON.stringify(["f-sales", "f-regions"]),
    );
    renderApp("/dashboards?folder=f-north");
    const nav = await tree();
    const north = await within(nav).findByRole("button", { name: "North" });
    expect(north.getAttribute("aria-current")).toBe("true");
    await waitFor(() =>
      expect(within(nav).getByRole("button", { name: "Sales" }).getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
  });
});
