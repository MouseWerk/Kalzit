import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { addMongoSource, MONGO_ID } from "../datasources/test/fakeDatasources";
import { emptyModel, type PanelModel } from "./model";
import { addDashboard } from "./test/fakeDashboards";

/** A document explorer over a MongoDB collection larger than one page. */
const panel: PanelModel = {
  id: "p-orders",
  type: "documents",
  title: "Orders",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [
    { refId: "A", datasourceId: MONGO_ID, query: { collection: "orders", pipeline: "[]" } },
  ],
  transformations: [],
  options: {},
  fieldConfig: {},
};

function open() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "viewer" }] },
  });
  addMongoSource(server.areas.datasources);
  server.areas.datasources.mongo.orders = Array.from({ length: 1200 }, (_, i) => ({ n: i }));
  addDashboard(server.areas.dashboards, "d-shop", { ...emptyModel("Shop"), panels: [panel] });
  return { server, ...renderApp("/dashboards/d-shop") };
}

describe("load more in a dashboard's document panel", () => {
  it("continues the stored query through the panel route and appends the page", async () => {
    const { server, user } = open();
    const orders = await screen.findByRole("article", { name: "Orders" }, { timeout: 4000 });
    expect(
      await within(orders).findByText(
        "1,000 documents. Cut off at 1,000 documents. The source has more.",
      ),
    ).toBeTruthy();
    const first = server.areas.dashboards.panelQueries.length;
    await user.click(within(orders).getByRole("button", { name: "Load more documents" }));
    expect(await within(orders).findByText("1,200 documents.")).toBeTruthy();
    // The viewer only continues the stored query: the panel route with the set's cursor.
    const sent = server.areas.dashboards.panelQueries.slice(first);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.cursors).toEqual({ A: "1000" });
    expect(server.areas.datasources.queries).toHaveLength(0);
    expect(within(orders).queryByRole("button", { name: "Load more documents" })).toBeNull();
  });

  it("says why a page could not be loaded, and a refresh starts from the first page again", async () => {
    const { server, user } = open();
    const orders = await screen.findByRole("article", { name: "Orders" }, { timeout: 4000 });
    await within(orders).findByText(/Cut off at 1,000 documents/);
    // The data source is gone by the time the next page is asked for.
    server.areas.datasources.datasources = server.areas.datasources.datasources.filter(
      (d) => d.id !== MONGO_ID,
    );
    await user.click(within(orders).getByRole("button", { name: "Load more documents" }));
    expect(await within(orders).findByRole("alert")).toBeTruthy();
    // The first page stays.
    expect(within(orders).getByText(/1,000 documents\./)).toBeTruthy();

    addMongoSource(server.areas.datasources);
    await user.click(within(orders).getByRole("button", { name: "Load more documents" }));
    await within(orders).findByText("1,200 documents.");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(within(orders).getByText(/Cut off at 1,000 documents/)).toBeTruthy(),
    );
    expect(server.areas.dashboards.panelQueries.at(-1)?.body.cursors).toEqual({});
  });
});
