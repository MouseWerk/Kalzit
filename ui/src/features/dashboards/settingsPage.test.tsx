import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { pickOption } from "../../test/select";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { emptyModel } from "./model";
import { addDashboard, addFolder, latest } from "./test/fakeDashboards";

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

  it("opens General for an unknown section and offers Apply only in edit mode", async () => {
    setup("editor");
    renderApp("/dashboards/d-main/settings?section=nonsense");
    expect(await screen.findByRole("region", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("asks once when leaving with changes in edit mode", async () => {
    setup("editor");
    const { user } = renderApp("/dashboards/d-main?edit=true");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(await title(), " 2");
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumbs" });
    await user.click(within(crumbs).getByRole("link", { name: "Main" }));
    await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Leave" }));
    // Back on the dashboard, still in edit mode, without the settings change.
    expect(await screen.findByRole("heading", { level: 1, name: "Main" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeTruthy();
  });

  it("keeps the changes marked when the save dialog is cancelled", async () => {
    setup("editor");
    const { user } = renderApp("/dashboards/d-main/settings");
    await user.type(await title(), " 2");
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const save = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(save).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save…" })).toHaveProperty("disabled", false);
  });

  it("saves on the version it started from, so a newer one asks instead of being overwritten", async () => {
    const { stored } = setup("editor");
    const { user } = renderApp("/dashboards/d-main/settings");
    await user.type(await title(), " mine");
    // Someone else saves meanwhile.
    stored.versions.push({
      ...latest(stored),
      version: latest(stored).version + 1,
      model: { ...latest(stored).model, title: "Theirs" },
    });
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Someone else saved this dashboard" }),
    ).toBeTruthy();
    expect(latest(stored).model.title).toBe("Theirs");
  });

  it("opens the JSON with the page's changes, and in view mode without starting edit mode", async () => {
    setup("editor");
    const { user } = renderApp("/dashboards/d-main/settings");
    await user.type(await title(), " 2");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await user.click(within(nav).getByRole("link", { name: "JSON" }));
    await user.click(await screen.findByRole("button", { name: "JSON model…" }));
    const json = screen.getByRole("dialog", { name: "JSON model" });
    expect(
      (within(json).getByRole("textbox", { name: "Dashboard model" }) as HTMLTextAreaElement).value,
    ).toContain('"title": "Main 2"');
    await user.click(within(json).getByRole("button", { name: "Cancel" }));
    // The page keeps what was typed, and the dashboard is still in view mode.
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect((await screen.findAllByRole("button", { name: "Edit" })).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Save…" })).toBeNull();
  });

  it("does not let a viewer type into a variable's query", async () => {
    const { server, stored } = setup("viewer");
    // A viewer who may query the source sees the query, but may still not change it here.
    server.areas.datasources.grants[PG_ID] = "query";
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "city", type: "query", datasourceId: PG_ID, query: { sql: "SELECT city FROM a" } },
      ],
    };
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const section = await screen.findByRole("region", { name: "Variables" });
    // Inert, so it is out of the accessibility tree too.
    const query = await within(section).findByRole("textbox", { name: "Query", hidden: true });
    await user.type(query, " x");
    expect((query as HTMLTextAreaElement).value).toBe("SELECT city FROM a");
    expect(section.querySelector("fieldset")?.hasAttribute("inert")).toBe(true);
  });

  it("applies in edit mode into the unsaved dashboard, which Save then keeps", async () => {
    const { stored } = setup("editor");
    const { user, location } = renderApp("/dashboards/d-main?edit=true");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.type(await title(), " 2");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    // Back on the dashboard, still editing, with the new title and nothing saved yet.
    expect(await screen.findByRole("heading", { level: 1, name: "Main 2" })).toBeTruthy();
    expect(location().pathname).toBe("/dashboards/d-main");
    expect(stored.versions).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.title).toBe("Main 2");
  });

  it("offers constant and interval variables and saves them", async () => {
    const { stored } = setup("editor");
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const section = await screen.findByRole("region", { name: "Variables" });
    await user.click(within(section).getByRole("button", { name: "Add variable" }));
    await user.click(within(section).getByRole("button", { name: "Add variable" }));
    const [first, second] = within(section).getAllByRole("combobox", { name: "Kind" });
    await pickOption(user, first as HTMLElement, "constant");
    const value = within(section).getByRole("textbox", { name: "Value" });
    await user.type(value, "Schweiz");
    await pickOption(user, second as HTMLElement, "interval");
    const editors = within(section).getAllByRole("region");
    const values = within(editors[1] as HTMLElement).getByRole("textbox", { name: "Values" });
    await user.type(values, "1m, 5m, 1h");
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.variables).toEqual([
      { name: "var1", type: "constant", options: [], current: "Schweiz" },
      { name: "var2", type: "interval", options: ["1m", "5m", "1h"] },
    ]);
  });

  it("moves variables up and down and duplicates one under a free name", async () => {
    const { stored } = setup("editor");
    latest(stored).model = {
      ...latest(stored).model,
      variables: [
        { name: "a", type: "textbox" },
        { name: "b", type: "custom", options: ["x", "y"], current: "y" },
      ],
    };
    const { user } = renderApp("/dashboards/d-main/settings?section=variables");
    const section = await screen.findByRole("region", { name: "Variables" });
    expect(within(section).getByRole("button", { name: "Move variable a up" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(within(section).getByRole("button", { name: "Move variable b up" }));
    await user.click(within(section).getByRole("button", { name: "Duplicate variable b" }));
    const names = () =>
      within(section)
        .getAllByRole("textbox", { name: "Name" })
        .map((field) => (field as HTMLInputElement).value);
    expect(names()).toEqual(["b", "b_copy", "a"]);
    await user.click(within(section).getByRole("button", { name: "Move variable b_copy down" }));
    expect(names()).toEqual(["b", "a", "b_copy"]);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    expect(latest(stored).model.variables.map((v) => v.name)).toEqual(["b", "a", "b_copy"]);
    expect(latest(stored).model.variables[2]).toMatchObject({ options: ["x", "y"], current: "y" });
  });

  it("moves the dashboard to another folder on save", async () => {
    const { server, stored } = setup("editor");
    addFolder(server.areas.dashboards, "f-ops", "Ops");
    const { user } = renderApp("/dashboards/d-main/settings");
    const general = await screen.findByRole("region", { name: "General" });
    const folder = await within(general).findByRole("combobox", { name: "Folder" });
    await pickOption(user, folder, "f-ops");
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.folderId).toBe("f-ops"));
  });

  it("deletes the dashboard after asking, and hides Delete without the right", async () => {
    const { stored } = setup("editor");
    const { user, location } = renderApp("/dashboards/d-main/settings");
    const general = await screen.findByRole("region", { name: "General" });
    await user.click(within(general).getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete dashboard?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stored.deletedAt).not.toBeNull());
    await waitFor(() => expect(location().pathname).toBe("/dashboards/trash"));
  });

  it("has no Delete for a viewer", async () => {
    setup("viewer");
    renderApp("/dashboards/d-main/settings");
    await title();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
  });

  it("lists the versions inline in the Versions section", async () => {
    const { stored } = setup("editor");
    stored.versions.push({
      ...latest(stored),
      version: 2,
      message: "Second try",
    });
    renderApp("/dashboards/d-main/settings?section=versions");
    const section = await screen.findByRole("region", { name: "Versions" });
    expect(await within(section).findByText("Second try")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Restore… version 1" })).toBeTruthy();
  });
});
