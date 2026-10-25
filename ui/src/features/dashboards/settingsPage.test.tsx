import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "./model";
import { addDashboard, latest } from "./test/fakeDashboards";

function setup(role: string) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
  });
  const stored = addDashboard(server.areas.dashboards, "d-main", emptyModel("Main"));
  return { server, stored };
}

async function title() {
  const general = await screen.findByRole("region", { name: "General" });
  return within(general).getByRole("textbox", { name: "Title" });
}

describe("the dashboard settings page", () => {
  it("has its own address, a section per entry, and keeps changes across sections", async () => {
    setup("editor");
    const { user, location } = renderApp("/dashboards/d-main/settings");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Dashboard settings" }),
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "General",
      "Variables",
      "Annotations",
      "Links",
      "Time options",
      "Access",
      "Versions",
      "JSON",
    ]);
    expect(within(nav).getByRole("link", { name: "General" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "Save…" })).toHaveProperty("disabled", true);
    await user.type(await title(), " 2");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(within(nav).getByRole("link", { name: "Versions" }));
    expect(await screen.findByRole("region", { name: "Versions" })).toBeTruthy();
    expect(location().search).toMatchObject({ section: "versions" });
    await user.click(within(nav).getByRole("link", { name: "General" }));
    expect(await title()).toHaveProperty("value", "Main 2");
  });

  it("asks before leaving with changes, and Discard leaves without saving", async () => {
    const { stored } = setup("editor");
    const { user, location } = renderApp("/dashboards/d-main/settings");
    await user.type(await title(), " 2");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    await user.click(within(crumbs).getByRole("link", { name: "Dashboards" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(location().pathname).toBe("/dashboards/d-main/settings");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Main" })).toBeTruthy();
    expect(location().pathname).toBe("/dashboards/d-main");
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
    expect(stored.versions).toHaveLength(1);
  });

  it("saves from view mode with a message and returns to the dashboard", async () => {
    const { stored } = setup("editor");
    const { user, location } = renderApp("/dashboards/d-main/settings");
    const field = await title();
    await user.clear(field);
    await user.type(field, "Main board");
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const save = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(save).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.title).toBe("Main board");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main"));
  });

  it("shows the settings to a viewer without letting them change them", async () => {
    setup("viewer");
    renderApp("/dashboards/d-main/settings");
    // Disabled through the section's fieldset.
    expect((await title()).matches(":disabled")).toBe(true);
    expect(screen.getByText("You may look at these settings, but not change them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save…" })).toBeNull();
  });
});
