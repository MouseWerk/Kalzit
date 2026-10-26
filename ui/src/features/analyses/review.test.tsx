import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel, type PanelModel } from "../dashboards/model";
import { addDashboard, latest } from "../dashboards/test/fakeDashboards";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { addAnalysis, newestOf, saveElsewhere } from "./test/fakeAnalyses";

function setup(role = "editor") {
  return installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
  });
}

function customers(server: ReturnType<typeof setup>, title = "Customers") {
  return addAnalysis(server.areas.analyses, {
    title,
    datasourceId: PG_ID,
    query: { sql: "SELECT * FROM customers" },
    description: "Everyone who bought",
  });
}

async function openDirty(server: ReturnType<typeof setup>) {
  const stored = customers(server);
  const view = renderApp(`/explore?analysis=${stored.id}`);
  expect(await screen.findByRole("heading", { name: "Customers" })).toBeTruthy();
  fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
    target: { value: "SELECT name FROM customers" },
  });
  expect(await screen.findByText("Changed")).toBeTruthy();
  return { stored, ...view };
}

describe("viewers and saved analyses", () => {
  it("find the list in the sidebar, open an analysis read-only and run it", async () => {
    const server = setup("viewer");
    const stored = customers(server);
    const { user, location } = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    // No Explore for a viewer, but the saved analyses.
    expect(within(nav).queryByRole("link", { name: "Explore" })).toBeNull();
    await user.click(await within(nav).findByRole("link", { name: "Analyses" }));
    await waitFor(() => expect(location().pathname).toBe("/explore/saved"));
    await user.click(await screen.findByRole("link", { name: "Open Customers" }));
    await waitFor(() => expect(location().pathname).toBe(`/explore/saved/${stored.id}`));

    expect(await screen.findByRole("heading", { name: "Customers", level: 1 })).toBeTruthy();
    expect(screen.getByText("Everyone who bought")).toBeTruthy();
    // It runs as stored, through the analysis's own route.
    expect(await screen.findByText("Grace")).toBeTruthy();
    expect(server.areas.analyses.runs.at(-1)?.id).toBe(stored.id);
    expect(server.areas.analyses.runs.at(-1)?.body.variables).toBeUndefined();
    expect(screen.getByText(/View only: the query runs as saved/)).toBeTruthy();
    // Nothing to edit.
    expect(screen.queryByRole("link", { name: "Edit in Explore" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Query" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(server.areas.analyses.runs).toHaveLength(2));
  });

  it("offer Edit in Explore on the view to whoever may query the source", async () => {
    const server = setup();
    const stored = customers(server);
    renderApp(`/explore/saved/${stored.id}`);
    const edit = await screen.findByRole("link", { name: "Edit in Explore" });
    expect(edit.getAttribute("href")).toBe(`/explore?analysis=${stored.id}`);
  });
});

describe("saving guards", () => {
  it("sends one save for two quick Ctrl+S", async () => {
    const server = setup();
    await openDirty(server);
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText("Changed")).toBeNull());
    expect(server.areas.analyses.saves).toHaveLength(1);
    expect(server.areas.analyses.saves[0]?.body.version).toBe(1);
  });

  it("opens the conflict dialog on a rename over a newer version, and renames over it", async () => {
    const server = setup();
    const stored = customers(server);
    const { user } = renderApp(`/explore?analysis=${stored.id}`);
    expect(await screen.findByRole("heading", { name: "Customers" })).toBeTruthy();
    saveElsewhere(stored, (model) => ({ ...model, visualization: { type: "barchart" } }));
    await user.click(screen.getByRole("button", { name: "More save options" }));
    await user.click(screen.getByRole("menuitem", { name: /Rename and describe/ }));
    const rename = await screen.findByRole("dialog", { name: "Rename and describe" });
    const name = within(rename).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Buyers");
    await user.click(within(rename).getByRole("button", { name: "Apply" }));
    const conflict = await screen.findByRole("dialog", { name: "A newer version exists" });
    await user.click(within(conflict).getByRole("button", { name: "Overwrite anyway" }));
    await waitFor(() => expect(newestOf(stored).model.title).toBe("Buyers"));
    expect(server.areas.analyses.saves.at(-1)?.body.version).toBe(2);
  });

  it("opens the conflict dialog on a move over a newer version", async () => {
    const server = setup();
    const stored = customers(server);
    const { user } = renderApp(`/explore?analysis=${stored.id}`);
    expect(await screen.findByRole("heading", { name: "Customers" })).toBeTruthy();
    saveElsewhere(stored, (model) => model);
    await user.click(screen.getByRole("button", { name: "More save options" }));
    await user.click(screen.getByRole("menuitem", { name: /Move/ }));
    const move = await screen.findByRole("dialog", { name: "Move analysis" });
    await user.click(within(move).getByRole("button", { name: "Move" }));
    expect(await screen.findByRole("dialog", { name: "A newer version exists" })).toBeTruthy();
    expect(stored.versions).toHaveLength(2);
  });
});

describe("unsaved changes", () => {
  it("asks before leaving Explore, and stays on request", async () => {
    const server = setup();
    const { user, location } = await openDirty(server);
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    const ask = await screen.findByRole("dialog", { name: "Discard the changes?" });
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(location().pathname).toBe("/explore");
    expect(screen.getByText("Changed")).toBeTruthy();

    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    const again = await screen.findByRole("dialog", { name: "Discard the changes?" });
    await user.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards"));
  });

  it("asks before opening another analysis", async () => {
    const server = setup();
    const other = customers(server, "Payments");
    const { user, location } = await openDirty(server);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const picker = await screen.findByRole("dialog", { name: "Open analysis" });
    await user.click(await within(picker).findByRole("option", { name: /Payments/ }));
    const ask = await screen.findByRole("dialog", { name: "Discard the changes?" });
    await user.click(within(ask).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(location().search).toEqual({ analysis: other.id }));
    expect(await screen.findByRole("heading", { name: "Payments" })).toBeTruthy();
  });
});

describe("a linked panel in the editor", () => {
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

  async function openLinked(server: ReturnType<typeof setup>) {
    const analysis = customers(server);
    const stored = addDashboard(server.areas.dashboards, "d-main", {
      ...emptyModel("Main"),
      panels: [
        panel("p1", "Orders"),
        { ...panel("p2", "Buyers"), targets: [], analysisId: analysis.id },
      ],
    });
    const view = renderApp("/dashboards/d-main");
    await view.user.click(await screen.findByRole("button", { name: "Edit" }));
    await view.user.click(
      within(await screen.findByRole("article", { name: "Buyers" })).getByRole("button", {
        name: "Panel menu of “Buyers”",
      }),
    );
    await view.user.click(screen.getByRole("menuitem", { name: "Edit “Buyers”" }));
    const editor = await screen.findByRole("region", { name: "Edit panel" });
    const header = await within(editor).findByRole("article", {
      name: "Linked analysis Customers",
    });
    return { analysis, stored, editor, header, ...view };
  }

  async function save(user: ReturnType<typeof renderApp>["user"], editor: HTMLElement) {
    await user.click(within(editor).getByRole("button", { name: "Save dashboard…" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Save dashboard" })).getByRole("button", {
        name: "Save",
      }),
    );
  }

  it("draws a stored link from the analysis and unlinks into a copy of its queries", async () => {
    const server = setup();
    const { stored, editor, header, user } = await openLinked(server);
    await user.click(within(header).getByRole("button", { name: "Unlink" }));
    expect(within(editor).queryByRole("article", { name: /Linked analysis/ })).toBeNull();
    expect(await within(editor).findByLabelText("Query A", { selector: "textarea" })).toBeTruthy();
    await save(user, editor);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const p2 = latest(stored).model.panels.find((p) => p.id === "p2");
    expect(p2?.analysisId).toBeUndefined();
    expect(p2?.targets).toEqual([
      { refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM customers" } },
    ]);
  });

  it("removes the link and starts the panel over with an empty query", async () => {
    const server = setup();
    const { stored, editor, header, user } = await openLinked(server);
    await user.click(within(header).getByRole("button", { name: "Remove" }));
    expect(within(editor).queryByRole("article", { name: /Linked analysis/ })).toBeNull();
    await save(user, editor);
    await waitFor(() => expect(stored.versions).toHaveLength(2));
    const p2 = latest(stored).model.panels.find((p) => p.id === "p2");
    expect(p2?.analysisId).toBeUndefined();
    expect(p2?.targets.map((t) => t.query)).not.toContainEqual({
      sql: "SELECT * FROM customers",
    });
  });
});
