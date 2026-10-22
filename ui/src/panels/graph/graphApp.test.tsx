import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { emptyModel, type PanelModel } from "../../features/dashboards/model";
import { addDashboard } from "../../features/dashboards/test/fakeDashboards";
import { addNeo4jSource, PG_ID } from "../../features/datasources/test/fakeDatasources";
import { ID, NEO4J_ID } from "../../features/datasources/test/fakeGraph";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function graphPanel(options: Record<string, unknown>): PanelModel {
  return {
    id: "p-graph",
    type: "network",
    title: "Purchases",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [
      {
        refId: "A",
        datasourceId: NEO4J_ID,
        query: { cypher: "MATCH (c)-[b]->(p) RETURN c, b, p" },
      },
    ],
    transformations: [],
    options,
    fieldConfig: {},
  };
}

function setup(role: string, options: Record<string, unknown>, extra: PanelModel[] = []) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  addNeo4jSource(server.areas.datasources);
  addDashboard(server.areas.dashboards, "d-shop", {
    ...emptyModel("Shop"),
    variables: [{ name: "customerId", type: "textbox", current: "1" }],
    panels: [graphPanel(options), ...extra],
  });
  return server;
}

describe("graph panels on a dashboard", () => {
  it("loads a node's neighbours in explorer mode and undoes the step", async () => {
    const server = setup("editor", { explorer: true, expandLimit: 10 });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    expect(await within(panel).findByRole("button", { name: "Oak & Co" })).toBeTruthy();
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(sent.queries[0]?.query).toEqual({
      cypher: "MATCH (n)-[r]-(m) WHERE elementId(n) = $nodeId RETURN n, r, m LIMIT 10",
    });
    expect(sent.variables).toEqual({ nodeId: ID.desk });

    await user.click(within(panel).getByRole("button", { name: "Undo: neighbours of Desk" }));
    expect(within(panel).queryByRole("button", { name: "Oak & Co" })).toBeNull();
    expect(within(panel).getByRole("status").textContent).toBe("Neighbours of Desk removed");
  });

  it("says why a viewer cannot load neighbours", async () => {
    setup("viewer", { explorer: true });
    renderApp("/dashboards/d-shop");
    expect(
      await screen.findByText("Loading neighbours needs query access to the data source."),
    ).toBeTruthy();
  });

  it("sets a dashboard variable from a node, which other panels then query with", async () => {
    const table: PanelModel = {
      id: "p-orders",
      type: "table",
      title: "Orders",
      grid: { x: 12, y: 0, w: 12, h: 8 },
      targets: [
        {
          refId: "A",
          datasourceId: PG_ID,
          query: { sql: "SELECT * FROM o WHERE c = $customerId" },
        },
      ],
      transformations: [],
      options: {},
      fieldConfig: {},
    };
    const server = setup("viewer", { variable: "customerId", variableProperty: "customerId" }, [
      table,
    ]);
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Grace" }));
    // The variable bar follows, and so does the other panel's query.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "customerId" })).toHaveProperty("value", "43"),
    );
    await waitFor(() =>
      expect(
        server.areas.dashboards.panelQueries.some(
          (q) => q.panelId === "p-orders" && q.body.variables.customerId === "43",
        ),
      ).toBe(true),
    );
  });
});

describe("Explore with a graph source", () => {
  it("queries in Cypher with completion from the schema and shows the network", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("editor") });
    addNeo4jSource(server.areas.datasources);
    const { user } = renderApp("/explore");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Data source" }),
      "Graph DB",
    );
    const editor = await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(editor, { target: { value: "MATCH (c:Cu" } });
    expect(await screen.findByRole("option", { name: /Customer/ })).toBeTruthy();
    fireEvent.change(editor, { target: { value: "MATCH (c)-[b]->(p) RETURN c, b, p" } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("table", { name: "Nodes of Result: 4" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Visualization" })).toHaveProperty(
      "value",
      "network",
    );
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(sent.queries[0]?.query).toEqual({ cypher: "MATCH (c)-[b]->(p) RETURN c, b, p" });
  });
});
