import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { emptyModel, type PanelModel } from "../features/dashboards/model";
import { addDashboard, latest } from "../features/dashboards/test/fakeDashboards";
import { addMongoSource, MONGO_ID } from "../features/datasources/test/fakeDatasources";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

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
    await user.click(screen.getByRole("button", { name: "Edit “Orders”" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit panel" });

    expect(within(dialog).getByText(/Another column is already named “total”/)).toBeTruthy();
    const apply = within(dialog).getByRole("button", { name: "Apply" });
    expect(apply).toHaveProperty("disabled", true);
    expect(within(dialog).getByText(/Fix the projection step before applying/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Name of column 2"), {
      target: { value: "Total again" },
    });
    expect(apply).toHaveProperty("disabled", false);
    await user.click(apply);
    await user.click(screen.getByRole("button", { name: "Save…" }));
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
