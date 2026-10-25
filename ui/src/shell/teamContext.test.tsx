import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyModel } from "../features/dashboards/model";
import { addDashboard, addFolder, type FakeTeam } from "../features/dashboards/test/fakeDashboards";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

const OPS: FakeTeam = { id: "t-ops", name: "Operations", member: true, maintainer: true };
const SALES: FakeTeam = { id: "t-sales", name: "Sales", member: true, maintainer: false };

function setup(teams: FakeTeam[], role = "owner") {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "MouseWerk", role }] },
  });
  const { dashboards } = server.areas;
  dashboards.teams = teams;
  addFolder(dashboards, "f-general", "General");
  addFolder(dashboards, "f-ops", "Operations space", { ownerTeamId: OPS.id });
  addFolder(dashboards, "f-sales", "Sales space", { ownerTeamId: SALES.id });
  addDashboard(dashboards, "d-net", emptyModel("Network load"), { folderId: "f-ops" });
  addDashboard(dashboards, "d-deals", emptyModel("Deals"), { folderId: "f-sales" });
  addDashboard(dashboards, "d-all", emptyModel("Company"), { folderId: "f-general" });
  return server;
}

function folderNames(): string[] {
  const tree = screen.getByRole("navigation", { name: "Folders" });
  return within(tree)
    .getAllByRole("button")
    .map((button) => button.querySelector(".truncate")?.textContent ?? "");
}

describe("team context in the workspace card", () => {
  it("shows the organization and the active team, and switches teams", async () => {
    const server = setup([OPS, SALES]);
    const { user } = renderApp("/");
    const card = await screen.findByRole("button", { name: "Organization MouseWerk Operations" });
    await user.click(card);
    const menu = await screen.findByRole("menu", { name: "Organization menu" });
    const team = within(menu).getByRole("group", { name: "Team" });
    const options = within(team).getAllByRole("menuitemradio");
    expect(options.map((o) => o.textContent)).toEqual(["Operations", "Sales", "All areas"]);
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");
    await user.click(within(team).getByRole("menuitemradio", { name: "Sales" }));
    await screen.findByRole("button", { name: "Organization MouseWerk Sales" });
    expect(server.calls).toContainEqual({
      method: "PUT",
      path: "/api/orgs/o1/team-context",
      body: { teamId: "t-sales" },
    });
    expect(server.areas.dashboards.teamId).toBe("t-sales");
  });

  it("names the only team without offering a switch", async () => {
    setup([OPS], "viewer");
    renderApp("/");
    await waitFor(() =>
      expect(document.querySelector(".org-switcher__role")?.textContent).toBe("Operations"),
    );
    // A viewer has nothing else in the menu, so the card stays a plain card.
    expect(document.querySelector(".org-switcher--static")).not.toBeNull();
    expect(screen.queryByRole("group", { name: "Team" })).toBeNull();
  });

  it("keeps the role on the card for members without a team", async () => {
    setup([]);
    renderApp("/");
    expect(
      await screen.findByRole("button", { name: "Organization MouseWerk Owner" }),
    ).toBeTruthy();
  });
});

describe("team spaces on the Dashboards page", () => {
  it("shows the active team's space first and leaves out other teams' spaces", async () => {
    const server = setup([OPS, SALES]);
    const { user } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Network load" });
    expect(folderNames()).toEqual(["All dashboards", "Operations space", "General"]);
    expect(screen.queryByRole("link", { name: "Deals" })).toBeNull();
    // The space carries the team mark for screen readers too.
    const tree = screen.getByRole("navigation", { name: "Folders" });
    expect(within(tree).getByRole("button", { name: /Team space of Operations/ })).toBeTruthy();
    const listed = server.calls.filter((c) => c.path.startsWith("/api/orgs/o1/dashboards?"));
    expect(listed.every((c) => c.path.includes("team=t-ops"))).toBe(true);

    // All areas: every space the owner may see, the list unscoped.
    await user.click(screen.getByRole("button", { name: "Organization MouseWerk Operations" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "All areas" }));
    await screen.findByRole("link", { name: "Deals" });
    expect(folderNames()).toEqual(["All dashboards", "General", "Operations space", "Sales space"]);
  });

  it("creates a team space for a team the member maintains", async () => {
    const server = setup([OPS, SALES], "editor");
    const { user } = renderApp("/dashboards");
    await user.click(await screen.findByRole("button", { name: "Create team space" }));
    const dialog = await screen.findByRole("dialog", { name: "New team space" });
    // Only the team Ada maintains is offered.
    const select = within(dialog).getByRole("combobox", { name: "Team" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Operations"]);
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Ops dashboards");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const created = server.areas.dashboards.folders.find((f) => f.name === "Ops dashboards");
    expect(created?.ownerTeamId).toBe(OPS.id);
  });

  it("puts a new dashboard into the team space when the organization says so", async () => {
    const server = setup([OPS, SALES]);
    server.areas.dashboards.newInTeamSpace = true;
    const { user } = renderApp("/dashboards");
    await screen.findByRole("link", { name: "Network load" });
    await user.click(screen.getByRole("button", { name: "New dashboard" }));
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    const folder = within(dialog).getByRole("combobox", { name: "Folder" }) as HTMLSelectElement;
    expect(folder.value).toBe("f-ops");
  });

  it("offers team and visibility only to whoever may change them", async () => {
    setup([OPS, SALES], "editor");
    renderApp("/dashboards?folder=f-general");
    await screen.findByRole("button", { name: "Rename or move…" });
    expect(screen.queryByRole("button", { name: "Team and visibility" })).toBeNull();
  });

  it("offers team and visibility to whoever manages the folder's access", async () => {
    setup([OPS, SALES], "owner");
    renderApp("/dashboards?folder=f-general");
    expect(await screen.findByRole("button", { name: "Team and visibility" })).toBeTruthy();
  });
});
