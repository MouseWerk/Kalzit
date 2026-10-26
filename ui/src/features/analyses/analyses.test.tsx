import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel, type PanelModel } from "../dashboards/model";
import { addDashboard, latest } from "../dashboards/test/fakeDashboards";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { ANALYSES_KEY } from "./api";
import { addAnalysis, newestOf, saveElsewhere } from "./test/fakeAnalyses";

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function setup(role = "editor") {
  return installFakeServer({ signedIn: true, user: asRole(role) });
}

async function runSql(user: ReturnType<typeof renderApp>["user"], sql: string) {
  const editor = await screen.findByRole("textbox", { name: "Query" });
  fireEvent.change(editor, { target: { value: sql } });
  await user.click(screen.getByRole("button", { name: "Run query" }));
}

describe("saving in Explore", () => {
  it("saves a new query with name, location and description, following the range by default", async () => {
    const server = setup();
    const { user, location } = renderApp("/explore");
    expect(await screen.findByText("Untitled query")).toBeTruthy();
    await runSql(user, "SELECT * FROM customers");
    expect(await screen.findByText("Grace")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Save analysis" });
    // What is saved, and the range is not kept unless asked for.
    expect(within(dialog).getByText("Sales DB")).toBeTruthy();
    expect(within(dialog).getByText("1 query")).toBeTruthy();
    const keep = within(dialog).getByRole("checkbox", { name: /Keep the time range/ });
    expect((keep as HTMLInputElement).checked).toBe(false);
    const place = within(dialog).getByRole("combobox", { name: "Location" });
    expect((place as HTMLSelectElement).value).toBe("");
    expect(
      within(dialog).getByText(/Visible to everyone in the organization who may read analyses/),
    ).toBeTruthy();
    // A name is required.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByText("Give the analysis a name.")).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Customers");
    await user.type(
      within(dialog).getByRole("textbox", { name: /Description/ }),
      "Everyone who bought",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(server.areas.analyses.saves).toHaveLength(1));
    const model = server.areas.analyses.saves[0]?.body.model as Record<string, unknown>;
    expect(model).toMatchObject({
      schemaVersion: 1,
      title: "Customers",
      description: "Everyone who bought",
      timeRange: null,
      targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM customers" } }],
      visualization: { type: "table" },
    });
    // Saved: its name in the head, the address names it, and a toast leads to the list.
    expect(await screen.findByRole("heading", { name: "Customers" })).toBeTruthy();
    const id = server.areas.analyses.analyses[0]?.id;
    await waitFor(() => expect(location().search).toEqual({ analysis: id }));
    expect(screen.getByText("Saved in Organization (top level)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in the list" })).toBeTruthy();
    expect(screen.queryByText("Changed")).toBeNull();

    // A change shows "Changed"; Ctrl+S saves it over the stored version.
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT name FROM customers" },
    });
    expect(await screen.findByText("Changed")).toBeTruthy();
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(server.areas.analyses.saves).toHaveLength(2));
    expect(server.areas.analyses.saves[1]?.body.version).toBe(1);
    await waitFor(() => expect(screen.queryByText("Changed")).toBeNull());
  });

  it("offers save as, rename, move, versions and discard once saved", async () => {
    const server = setup();
    const stored = addAnalysis(server.areas.analyses, {
      title: "Orders by day",
      datasourceId: PG_ID,
      query: { sql: "SELECT * FROM customers" },
    });
    const { user } = renderApp(`/explore?analysis=${stored.id}`);
    expect(await screen.findByRole("heading", { name: "Orders by day" })).toBeTruthy();
    // Opening runs it.
    expect(await screen.findByText("Grace")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "More save options" }));
    const menu = screen.getByRole("menu", { name: "More save options" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.querySelector(".toolbar-menu__label")?.textContent),
    ).toEqual([
      "Save",
      "Save as…",
      "Rename and describe",
      "Move…",
      "Versions and history",
      "Discard changes",
    ]);
    // Nothing changed yet, so nothing to discard.
    expect(
      within(menu)
        .getByRole("menuitem", { name: /Discard changes/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await user.click(within(menu).getByRole("menuitem", { name: /Rename and describe/ }));
    const rename = await screen.findByRole("dialog", { name: "Rename and describe" });
    expect(within(rename).queryByRole("combobox", { name: "Location" })).toBeNull();
    const name = within(rename).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Orders per day");
    await user.click(within(rename).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(newestOf(stored).model.title).toBe("Orders per day"));
    expect(await screen.findByRole("heading", { name: "Orders per day" })).toBeTruthy();
  });
});

describe("the conflict on save", () => {
  async function openSaved() {
    const server = setup();
    const stored = addAnalysis(server.areas.analyses, {
      title: "Orders by day",
      datasourceId: PG_ID,
      query: { sql: "SELECT * FROM customers" },
    });
    const view = renderApp(`/explore?analysis=${stored.id}`);
    expect(await screen.findByRole("heading", { name: "Orders by day" })).toBeTruthy();
    fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
      target: { value: "SELECT name FROM customers" },
    });
    expect(await screen.findByText("Changed")).toBeTruthy();
    saveElsewhere(stored, (model) => ({ ...model, visualization: { type: "barchart" } }));
    return { server, stored, ...view };
  }

  it("names the newer version at once, before anything is saved", async () => {
    const { app } = await openSaved();
    await act(() => app.queryClient.invalidateQueries({ queryKey: [ANALYSES_KEY] }));
    const notice = await screen.findByText("Grace Hopper saved a newer version");
    expect(notice.closest("[role=status]")?.textContent).toMatch(
      /You are working on version 1, the current one is version 2/,
    );
    expect(screen.getByRole("button", { name: "View differences" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load the new version" })).toBeTruthy();
  });

  it("asks before overwriting and keeps the other version in the history", async () => {
    const { server, stored, user } = await openSaved();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "A newer version exists" });
    expect(within(dialog).getByText(/Grace Hopper saved “Orders by day”/)).toBeTruthy();
    // Both sides' changes against version 1.
    expect(within(dialog).getByText("Query A changed")).toBeTruthy();
    expect(within(dialog).getByText(/^Visualization: .* instead of Table$/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Load version 2" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save as a copy…" })).toBeTruthy();
    expect(
      within(dialog).getByText(/Version 2 stays in the history and can be restored/),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Overwrite anyway" }));
    await waitFor(() => expect(stored.versions).toHaveLength(3));
    expect(server.areas.analyses.saves.at(-1)?.body.version).toBe(2);
    expect(screen.queryByRole("dialog", { name: "A newer version exists" })).toBeNull();
  });

  it("saves a copy instead", async () => {
    const { server, user } = await openSaved();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "A newer version exists" });
    await user.click(within(dialog).getByRole("button", { name: "Save as a copy…" }));
    const saveAs = await screen.findByRole("dialog", { name: "Save as" });
    expect(within(saveAs).getByRole("textbox", { name: "Name" })).toHaveProperty(
      "value",
      "Orders by day (copy)",
    );
    await user.click(within(saveAs).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.analyses.analyses).toHaveLength(2));
    expect(await screen.findByRole("heading", { name: "Orders by day (copy)" })).toBeTruthy();
  });
});

describe("the list of saved analyses", () => {
  it("lists analyses with their source and locks Open without the query right", async () => {
    const server = setup();
    addAnalysis(server.areas.analyses, {
      title: "Customers",
      datasourceId: PG_ID,
      query: { sql: "SELECT 1" },
    });
    const locked = addAnalysis(server.areas.analyses, {
      title: "Payments",
      datasourceId: PG_ID,
      query: { sql: "SELECT 2" },
    });
    server.areas.analyses.noQuery.add(locked.id);
    server.areas.analyses.uses[locked.id] = [{ id: "d1", title: "Board one", deletedAt: null }];
    renderApp("/explore/saved");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const open = within(table).getByRole("link", { name: "Open Customers in Explore" });
    expect(open.getAttribute("href")).toMatch(/\/explore\?analysis=/);
    const lockedButton = within(table).getByRole("button", { name: "Open Payments in Explore" });
    expect(lockedButton.getAttribute("aria-disabled")).toBe("true");
    expect(lockedButton.title).toBe(
      "You may not query the data source “Sales DB”, so the analysis cannot be opened in Explore.",
    );
    expect(within(table).getByText("no query access for you")).toBeTruthy();
    expect(within(table).getByRole("button", { name: "1 dashboard" })).toBeTruthy();
    expect(screen.getByText("2 analyses in All analyses")).toBeTruthy();
  });

  it("shows an empty location with a way to Explore", async () => {
    setup();
    renderApp("/explore/saved");
    expect(
      await screen.findByRole("heading", { name: "No analyses in All analyses yet" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Explore" })).toBeTruthy();
  });

  it("says when a search found nothing and resets it", async () => {
    const server = setup();
    addAnalysis(server.areas.analyses, {
      title: "Customers",
      datasourceId: PG_ID,
      query: { sql: "SELECT 1" },
    });
    const { user } = renderApp("/explore/saved?q=lagerbestand");
    expect(
      await screen.findByRole("heading", { name: "Nothing found for “lagerbestand”" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(await screen.findByRole("link", { name: "Customers" })).toBeTruthy();
  });

  it("moves an analysis to the trash from its menu, and refuses while dashboards link it", async () => {
    const server = setup();
    const free = addAnalysis(server.areas.analyses, {
      title: "Customers",
      datasourceId: PG_ID,
      query: { sql: "SELECT 1" },
    });
    const linked = addAnalysis(server.areas.analyses, {
      title: "Payments",
      datasourceId: PG_ID,
      query: { sql: "SELECT 2" },
    });
    server.areas.analyses.uses[linked.id] = [{ id: "d1", title: "Board one", deletedAt: null }];
    const { user } = renderApp("/explore/saved");
    await user.click(await screen.findByRole("button", { name: "Actions for Payments" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    const refused = await screen.findByRole("dialog", { name: "Move to the trash?" });
    expect(within(refused).getByText(/stays while dashboards show it/)).toBeTruthy();
    expect(await within(refused).findByRole("link", { name: "Board one" })).toBeTruthy();
    // The dialog's own close button and the one at its foot: either closes it.
    const close = within(refused).getAllByRole("button", { name: "Close" }).at(-1);
    if (close !== undefined) {
      await user.click(close);
    }

    await user.click(screen.getByRole("button", { name: "Actions for Customers" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to trash" }));
    const confirm = await screen.findByRole("dialog", { name: "Move to the trash?" });
    await user.click(within(confirm).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(free.deletedAt).not.toBeNull());
    expect(await screen.findByText("“Customers” moved to the trash")).toBeTruthy();
  });
});

describe("a panel from a saved analysis", () => {
  function panel(id: string, title: string): PanelModel {
    return {
      id,
      type: "table",
      title,
      grid: { x: 0, y: 0, w: 12, h: 8 },
      targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
      transformations: [],
      options: {},
      fieldConfig: {},
    };
  }

  it("picks an analysis with a live preview and links it into the panel", async () => {
    const server = setup();
    const stored = addDashboard(server.areas.dashboards, "d-main", {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders")],
    });
    const analysis = addAnalysis(server.areas.analyses, {
      title: "Customers",
      datasourceId: PG_ID,
      query: { sql: "SELECT * FROM customers" },
      description: "Everyone who bought",
    });
    const blocked = addAnalysis(server.areas.analyses, {
      title: "Team secrets",
      datasourceId: PG_ID,
      query: { sql: "SELECT 1" },
      teamOnly: true,
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      within(screen.getByRole("complementary", { name: "Dashboard tools" })).getByRole("button", {
        name: "Add",
      }),
    );
    await user.click(screen.getByRole("button", { name: "All" }));
    const editor = await screen.findByRole("region", { name: "New panel" });
    // How the panel begins: a new query by default.
    const start = within(editor).getByRole("group", { name: "How should the panel begin?" });
    expect(
      (within(start).getByRole("radio", { name: /New query/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await user.click(within(start).getByRole("radio", { name: /From saved analysis/ }));

    const picker = await within(editor).findByRole("region", { name: "Choose a saved analysis" });
    const options = await within(picker).findByRole("listbox", { name: "Analyses" });
    const secret = within(options).getByRole("option", { name: /Team secrets/ });
    expect(secret.getAttribute("aria-disabled")).toBe("true");
    expect(within(secret).getByText(/not allowed in this dashboard/)).toBeTruthy();
    expect(blocked.id).not.toBe(analysis.id);
    // The first one that can be used is chosen and runs as viewers would see it.
    expect(
      within(options)
        .getByRole("option", { name: /Customers/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await within(picker).findByText("Grace")).toBeTruthy();
    expect(server.areas.analyses.runs.at(-1)?.id).toBe(analysis.id);
    expect(within(picker).getByText("Time range follows the dashboard")).toBeTruthy();
    const linked = within(picker).getByRole("radio", { name: /^Linked/ }) as HTMLInputElement;
    expect(linked.checked).toBe(true);
    await user.click(within(picker).getByRole("button", { name: "Use analysis" }));

    // Linked: the analysis named above its read-only queries.
    const header = await within(editor).findByRole("article", {
      name: "Linked analysis Customers",
    });
    expect(within(header).getByRole("link", { name: "Edit in Explore" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(within(editor).getByRole("textbox", { name: "Panel title" })).toHaveProperty(
      "value",
      "Customers",
    );

    await user.click(within(editor).getByRole("button", { name: "Save dashboard…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const added = latest(stored).model.panels.find((p) => p.id !== "p1");
    // The slot names the analysis and holds no queries of its own.
    expect(added).toMatchObject({ analysisId: analysis.id, targets: [], transformations: [] });
  });

  it("takes a copy instead, with the queries in the panel", async () => {
    const server = setup();
    const stored = addDashboard(server.areas.dashboards, "d-main", {
      ...emptyModel("Main"),
      panels: [panel("p1", "Orders")],
    });
    addAnalysis(server.areas.analyses, {
      title: "Customers",
      datasourceId: PG_ID,
      query: { sql: "SELECT * FROM customers" },
    });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(
      within(screen.getByRole("complementary", { name: "Dashboard tools" })).getByRole("button", {
        name: "Add",
      }),
    );
    await user.click(screen.getByRole("button", { name: "All" }));
    const editor = await screen.findByRole("region", { name: "New panel" });
    await user.click(within(editor).getByRole("radio", { name: /From saved analysis/ }));
    const picker = await within(editor).findByRole("region", { name: "Choose a saved analysis" });
    await within(picker).findByText("Grace");
    await user.click(within(picker).getByRole("radio", { name: /^As a copy/ }));
    await user.click(within(picker).getByRole("button", { name: "Use analysis" }));
    expect(within(editor).queryByRole("article", { name: /Linked analysis/ })).toBeNull();
    await user.click(within(editor).getByRole("button", { name: "Save dashboard…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const added = latest(stored).model.panels.find((p) => p.id !== "p1");
    expect(added?.analysisId).toBeUndefined();
    expect(added?.targets).toEqual([
      { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM customers" } },
    ]);
  });
});

describe("analyses in the command palette", () => {
  it("finds a saved analysis by name and opens it in Explore", async () => {
    const server = setup();
    const stored = addAnalysis(server.areas.analyses, {
      title: "Customers by city",
      datasourceId: PG_ID,
      query: { sql: "SELECT * FROM customers" },
    });
    const { user, location } = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.paste("custom");
    const option = await within(dialog).findByRole("option", { name: /Customers by city/ });
    expect(option.textContent).toContain("Analysis");
    await user.click(option);
    await waitFor(() => expect(location().pathname).toBe("/explore"));
    expect(location().search).toEqual({ analysis: stored.id });
  });
});
