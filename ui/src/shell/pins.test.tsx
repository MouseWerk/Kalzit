import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Me } from "../api/auth";
import { emptyModel } from "../features/dashboards/model";
import { addDashboard, addFolder } from "../features/dashboards/test/fakeDashboards";
import { currentOrgOf } from "../org/useOrg";
import { markEntered } from "../preferences/startDashboard";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { initialsOf } from "./UserMenu";

function setup(role = "editor", orgs = [{ id: "o1", name: "Org", role }]) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs },
  });
  const { dashboards } = server.areas;
  addFolder(dashboards, "f-ops", "Operations");
  addFolder(dashboards, "f-hr", "People", { restricted: true });
  addDashboard(dashboards, "d-sales", emptyModel("Sales overview"), { folderId: "f-ops" });
  addDashboard(dashboards, "d-people", emptyModel("Salaries"), { folderId: "f-hr" });
  addDashboard(dashboards, "d-stock", emptyModel("Stock"));
  return server;
}

const pinnedRegion = () => screen.findByRole("region", { name: "Pinned" });

describe("pinned dashboards in the sidebar", () => {
  it("lists pins in their order and leaves out what the user cannot read", async () => {
    const server = setup();
    server.areas.shell.pins.push(
      { dashboardId: "d-stock", at: 1 },
      { dashboardId: "d-people", at: 2 },
      { dashboardId: "d-sales", at: 3 },
    );
    renderApp("/");
    const region = await pinnedRegion();
    await within(region).findByRole("link", { name: "Stock" });
    expect(
      within(region)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Stock", "Sales overview"]);
    expect(within(region).getByRole("link", { name: "Sales overview" }).getAttribute("href")).toBe(
      "/dashboards/d-sales",
    );
  });

  it("pins a dashboard found by name, reorders and unpins through each pin's menu", async () => {
    const server = setup();
    const { user } = renderApp("/");
    const region = await pinnedRegion();
    await user.click(within(region).getByRole("button", { name: "Pin dashboard" }));
    const dialog = await screen.findByRole("dialog", { name: "Pin a dashboard" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Find a dashboard" }), "sto");
    await user.click(await within(dialog).findByRole("button", { name: "Stock" }));
    await within(region).findByRole("link", { name: "Stock" });
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(within(region).getByRole("button", { name: "Pin dashboard" }));
    const again = await screen.findByRole("dialog", { name: "Pin a dashboard" });
    // Already pinned dashboards are not offered again.
    await within(again).findByRole("button", { name: /Sales overview/ });
    expect(within(again).queryByRole("button", { name: "Stock" })).toBeNull();
    await user.click(within(again).getByRole("button", { name: /Sales overview/ }));
    await within(region).findByRole("link", { name: "Sales overview" });
    const titles = () =>
      within(region)
        .getAllByRole("link")
        .map((link) => link.textContent);
    expect(titles()).toEqual(["Stock", "Sales overview"]);

    await user.click(
      within(region).getByRole("button", { name: "Pin options for Sales overview" }),
    );
    const menu = screen.getByRole("menu", { name: "Pin options for Sales overview" });
    // The last pin cannot move further down.
    expect(within(menu).queryByRole("menuitem", { name: "Move down" })).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(titles()).toEqual(["Sales overview", "Stock"]));
    expect(server.areas.shell.pins.map((p) => p.dashboardId)).toEqual(["d-sales", "d-stock"]);

    await user.click(within(region).getByRole("button", { name: "Pin options for Stock" }));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() => expect(titles()).toEqual(["Sales overview"]));
    // Focus moves to the pin before it, since the menu button is gone.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole("link", { name: "Sales overview" }),
      ),
    );
    // The last pin gone, focus lands on "Pin dashboard".
    await user.click(
      within(region).getByRole("button", { name: "Pin options for Sales overview" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(region).getByRole("button", { name: "Pin dashboard" }),
      ),
    );
  });

  it("offers no more pins at the limit", async () => {
    const server = setup();
    for (let i = 0; i < 10; i++) {
      addDashboard(server.areas.dashboards, `d-${i}`, emptyModel(`Board ${i}`));
      server.areas.shell.pins.push({ dashboardId: `d-${i}`, at: i });
    }
    renderApp("/");
    const region = await pinnedRegion();
    await within(region).findByText("10 dashboards pinned, the most there can be.");
    expect(within(region).queryByRole("button", { name: "Pin dashboard" })).toBeNull();
  });

  it("pins the open dashboard from its rail", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-stock");
    const rail = await screen.findByRole("complementary", { name: "Dashboard tools" });
    const pin = await within(rail).findByRole("button", { name: "Pin to sidebar" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    await user.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("true"));
    const region = await pinnedRegion();
    expect(await within(region).findByRole("link", { name: "Stock" })).toBeTruthy();
    await user.click(pin);
    await waitFor(() => expect(within(region).queryByRole("link", { name: "Stock" })).toBeNull());
  });
});

describe("organization group and cards", () => {
  it("heads the organization group and lists members, settings and the administration", async () => {
    setup("owner");
    renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const group = (
      await within(nav).findAllByRole("list", { name: "Organization" })
    )[0] as HTMLElement;
    await within(group).findByRole("link", { name: "Members" });
    expect(within(group).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(within(group).getByRole("link", { name: "Administration" })).toBeTruthy();
  });

  it("offers the other organizations in the workspace menu", async () => {
    setup("owner", [
      { id: "o1", name: "Org", role: "owner" },
      { id: "o2", name: "Second", role: "viewer" },
    ]);
    const { user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: /^Organization Org/ }));
    const menu = screen.getByRole("menu", { name: "Organization menu" });
    const current = within(menu).getByRole("menuitemradio", { name: "Org" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(
      within(menu).getByRole("menuitemradio", { name: "Second" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("opens the start dashboard of the organization switched to, not of the first one", async () => {
    const orgs = [
      { id: "o1", name: "Org", role: "owner" },
      { id: "o2", name: "Second", role: "owner" },
    ];
    const server = setup("owner", orgs);
    window.localStorage.setItem(`kalzit.org.${TEST_USER.id}`, "o2");
    // A start dashboard in the first organization waits: the user works in the second one.
    server.state.preferences.startDashboard = { orgId: "o1", dashboardId: "d-stock" };
    const first = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    expect(first.location().pathname).toBe("/");
    first.view.unmount();
    markEntered(false);
    server.state.preferences.startDashboard = { orgId: "o2", dashboardId: "d-stock" };
    const second = renderApp("/");
    await waitFor(() => expect(second.location().pathname).toBe("/dashboards/d-stock"));
  });

  it("works in the organization last switched to while the user is a member", () => {
    const me: Me = {
      ...TEST_USER,
      orgs: [
        { id: "o1", name: "Org", role: "owner" },
        { id: "o2", name: "Second", role: "viewer" },
      ],
    };
    expect(currentOrgOf(me)?.id).toBe("o1");
    window.localStorage.setItem(`kalzit.org.${me.id}`, "o2");
    expect(currentOrgOf(me)?.id).toBe("o2");
    window.localStorage.setItem(`kalzit.org.${me.id}`, "o-gone");
    expect(currentOrgOf(me)?.id).toBe("o1");
  });

  it("shows two initials on the account card", () => {
    expect(initialsOf("Lea Hoffmann")).toBe("LH");
    expect(initialsOf("Ada Augusta King")).toBe("AK");
    expect(initialsOf("maria")).toBe("M");
    expect(initialsOf("Maria Keller (de)")).toBe("MK");
    expect(initialsOf("ßenja Weiß")).toBe("SW");
    expect(initialsOf("  ")).toBe("?");
  });
});
