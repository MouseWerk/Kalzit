import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyModel, type PanelModel } from "../features/dashboards/model";
import { addDashboard, latest } from "../features/dashboards/test/fakeDashboards";
import { addMongoSource, MONGO_ID } from "../features/datasources/test/fakeDatasources";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

/** Opens a panel's menu and picks an action, named as the old buttons were ("Edit “Orders”"). */
async function panelAction(user: ReturnType<typeof renderApp>["user"], name: string) {
  const title = /“(.*)”/.exec(name)?.[1] ?? "";
  const panel = await screen.findByRole("article", { name: title });
  await user.click(within(panel).getByRole("button", { name: `Panel menu of “${title}”` }));
  await user.click(await screen.findByRole("menuitem", { name }));
}

/** A table panel over MongoDB whose projection step names two columns "total", one has no path. */
const panel: PanelModel = {
  id: "p-orders",
  type: "table",
  title: "Orders",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [
    { refId: "A", datasourceId: MONGO_ID, query: { collection: "orders", pipeline: "[]" } },
  ],
  transformations: [
    {
      id: "0199f0a0-1c2e-4a4b-9e1d-3f5a6b7c8d90",
      type: "toFrame",
      frame: "A",
      columns: [{ path: "total" }, { path: "total" }, { path: "" }],
    },
  ],
  options: {},
  fieldConfig: {},
};

describe("the panel editor and the projection step", () => {
  it("applies a step only once the server would take it, and stores it without empty columns", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "editor" }],
      },
    });
    addMongoSource(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-shop", { ...emptyModel("Shop"), panels: [panel] });
    const { user } = renderApp("/dashboards/d-shop");
    await user.click(await screen.findByRole("button", { name: "Edit" }, { timeout: 4000 }));
    await panelAction(user, "Edit “Orders”");
    const dialog = await screen.findByRole("region", { name: "Edit panel" });

    expect(within(dialog).getByText(/Another column is already named “total”/)).toBeTruthy();
    // Saving waits for the fix; so does going back (it stays in the editor and says why).
    const apply = within(dialog).getByRole("button", { name: "Save dashboard…" });
    expect(apply).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/Fix the projection step before applying/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Name of column 2"), {
      target: { value: "Total again" },
    });
    expect(apply).toHaveProperty("disabled", false);
    await user.click(apply);
    const save = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(save).getByRole("button", { name: "Save" }));
    const stored = server.areas.dashboards.dashboards.find((d) => d.id === "d-shop");
    await waitFor(() => expect(stored?.versions).toHaveLength(2));
    expect(latest(stored as never).model.panels[0]?.transformations).toEqual([
      {
        id: "0199f0a0-1c2e-4a4b-9e1d-3f5a6b7c8d90",
        type: "toFrame",
        frame: "A",
        columns: [{ path: "total" }, { path: "total", name: "Total again" }],
      },
    ]);
  });
});

describe("click-to-filter in the panel editor", () => {
  it("waits while a field holds text that does not parse, and keeps that text", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "editor" }],
      },
    });
    addMongoSource(server.areas.datasources);
    const explorer: PanelModel = {
      ...panel,
      type: "documents",
      targets: [
        {
          refId: "A",
          datasourceId: MONGO_ID,
          query: { collection: "orders", pipeline: '[{"$limit": 5}]' },
        },
      ],
      transformations: [],
    };
    addDashboard(server.areas.dashboards, "d-shop", { ...emptyModel("Shop"), panels: [explorer] });
    const { user } = renderApp("/dashboards/d-shop");
    await user.click(await screen.findByRole("button", { name: "Edit" }, { timeout: 4000 }));
    await panelAction(user, "Edit “Orders”");
    const dialog = await screen.findByRole("region", { name: "Edit panel" });
    const tree = await within(dialog).findByRole("tree", { name: "Orders" });
    const before = server.areas.datasources.queries.length;
    const typing = '{"$limit": ';
    fireEvent.change(within(dialog).getByLabelText("Stage 1"), { target: { value: typing } });
    await user.click(within(tree).getAllByRole("treeitem")[0] as HTMLElement);
    const status = within(tree)
      .getAllByRole("treeitem")
      .find((row) => row.querySelector(".doc-tree__key")?.textContent === "status") as HTMLElement;
    await user.click(status);
    await user.click(within(dialog).getByRole("button", { name: "Filter by value" }));
    expect(
      within(dialog).getByText(/the query being edited has text that is not valid JSON/),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText("Stage 1")).toHaveProperty("value", typing);
    expect(server.areas.datasources.queries).toHaveLength(before);
  });
});

describe("library panels and the documents UI", () => {
  it("draws a library panel's projection and a library document panel in their slots", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "editor" }],
      },
    });
    addMongoSource(server.areas.datasources);
    const target = {
      refId: "A",
      datasourceId: MONGO_ID,
      query: { collection: "orders", pipeline: "[]" },
    };
    const library = (id: string, model: Record<string, unknown>) => ({
      id,
      folderId: null,
      name: id,
      model: { schemaVersion: 2, options: {}, fieldConfig: {}, ...model },
      version: 1,
    });
    server.areas.dashboardFeatures.libraryPanels.push(
      library("lib-table", {
        type: "table",
        title: "Order totals",
        targets: [target],
        transformations: [
          {
            id: "0199f0a0-1c2e-4a4b-9e1d-3f5a6b7c8d93",
            type: "toFrame",
            frame: "A",
            columns: [{ path: "total", name: "Total" }],
          },
        ],
      }),
      library("lib-docs", {
        type: "documents",
        title: "Order documents",
        targets: [target],
        transformations: [],
      }),
    );
    // The dashboard holds only the slots: their place, no queries or steps.
    const slot = (id: string, title: string, x: number, libraryPanelId: string): PanelModel => ({
      id,
      type: "table",
      title,
      grid: { x, y: 0, w: 12, h: 8 },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
      libraryPanelId,
    });
    addDashboard(server.areas.dashboards, "d-shop", {
      ...emptyModel("Shop"),
      panels: [
        slot("p-1", "Order totals", 0, "lib-table"),
        slot("p-2", "Order documents", 12, "lib-docs"),
      ],
    });
    renderApp("/dashboards/d-shop");
    const totals = await screen.findByRole("article", { name: "Order totals" }, { timeout: 4000 });
    expect(await within(totals).findByRole("columnheader", { name: /Total/ })).toBeTruthy();
    const documents = await screen.findByRole("article", { name: "Order documents" });
    expect(await within(documents).findByRole("tree", { name: "Order documents" })).toBeTruthy();
  });
});
