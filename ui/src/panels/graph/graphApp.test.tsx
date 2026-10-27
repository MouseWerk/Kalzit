import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { emptyModel, type PanelModel } from "../../features/dashboards/model";
import { addDashboard } from "../../features/dashboards/test/fakeDashboards";
import {
  addNeo4jSource,
  addTigerGraphSource,
  PG_ID,
} from "../../features/datasources/test/fakeDatasources";
import { ID, NEO4J_ID } from "../../features/datasources/test/fakeGraph";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";

// The graph panels load with their first use; loading them once here keeps that cost out of
// each test's own time, as renderApp does for the lazy pages.
beforeAll(async () => {
  await Promise.all([import("./GraphPanels"), import("../path/PathPanel")]);
});

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

/** The node table of a graph panel (tables are what jsdom shows). */
function nodes(panel: HTMLElement): HTMLElement {
  return within(panel).getByRole("table", { name: /^Nodes of / });
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
    expect(await within(nodes(panel)).findByRole("button", { name: "Oak & Co" })).toBeTruthy();
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(JSON.stringify(sent.queries[0]?.query)).toContain("SKIP 0 LIMIT 10");
    expect(sent.queries[1]?.refId).toBe("count");
    expect(sent.variables).toEqual({ nodeId: ID.desk });
    // The step with what it loaded of all the neighbours, and the announcement.
    const steps = within(panel).getByRole("region", { name: "Steps" });
    expect(within(steps).getByRole("button", { name: "Desk +1 of 1" })).toBeTruthy();
    expect(within(panel).getByRole("status").textContent).toBe("Neighbours of Desk loaded, 1 of 1");

    await user.click(within(steps).getByRole("button", { name: "Undo" }));
    expect(within(nodes(panel)).queryByRole("button", { name: "Oak & Co" })).toBeNull();
  });

  it("goes back to the query's result from the steps and loads with the next step's settings", async () => {
    const server = setup("editor", { explorer: true });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    const steps = await within(panel).findByRole("region", { name: "Steps" });
    await user.selectOptions(within(steps).getByRole("combobox", { name: "Direction" }), "out");
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    expect(await within(nodes(panel)).findByRole("button", { name: "Oak & Co" })).toBeTruthy();
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(JSON.stringify(sent.queries[0]?.query)).toContain("(n)-[e]->(m)");
    await user.click(within(steps).getByRole("button", { name: "Query result, 4 nodes" }));
    expect(within(nodes(panel)).queryByRole("button", { name: "Oak & Co" })).toBeNull();
  });

  it("keeps a pinned node when its step is taken back, and keeps pins for the viewer", async () => {
    const server = setup("editor", { explorer: true });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    await user.click(await within(nodes(panel)).findByRole("button", { name: "Oak & Co" }));
    await user.click(within(panel).getByRole("button", { name: "Pin" }));
    await user.click(
      within(within(panel).getByRole("region", { name: "Steps" })).getByRole("button", {
        name: "Undo",
      }),
    );
    expect(within(nodes(panel)).getByRole("button", { name: "Oak & Co" })).toBeTruthy();
    const pinned = within(panel).getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByText("step 1")).toBeTruthy();
    // Kept on the server for this viewer and panel, after a short pause.
    await waitFor(
      () =>
        expect(server.areas.dashboardFeatures.viewStates["d-shop/p-graph"]?.pinned).toEqual([
          ID.oak,
        ]),
      { timeout: 2_000 },
    );
  });

  it("opens the exploration as a query in Explore, unrun", async () => {
    const server = setup("editor", { explorer: true });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    expect(await within(nodes(panel)).findByRole("button", { name: "Oak & Co" })).toBeTruthy();
    const ran = server.areas.datasources.queries.length;
    await user.click(within(panel).getByRole("button", { name: "Open as a query in Explore" }));
    const editor = (await screen.findByRole("textbox", { name: "Query" })) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain(`WITH ["${ID.ada}"`));
    expect(editor.value).toContain(`"${ID.oak}"] AS ids`);
    expect(server.areas.datasources.queries.length).toBe(ran);
  });

  it("restores the pins and selection the viewer kept on this panel", async () => {
    const server = setup("viewer", {});
    server.areas.dashboardFeatures.viewStates["d-shop/p-graph"] = {
      pinned: [ID.lamp],
      selected: [ID.grace],
    };
    renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    expect(await within(panel).findByRole("region", { name: "Details of Grace" })).toBeTruthy();
    const pinned = within(panel).getByRole("region", { name: "Pinned" });
    expect(within(pinned).getByRole("button", { name: "Lamp" })).toBeTruthy();
  });

  it("sets a multi-value variable from a selection of several nodes", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    addNeo4jSource(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-shop", {
      ...emptyModel("Shop"),
      variables: [
        { name: "customers", type: "custom", options: ["42", "43"], multi: true, current: ["42"] },
      ],
      panels: [graphPanel({ variable: "customers", variableProperty: "customerId" })],
    });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await within(panel).findByRole("table", { name: /^Nodes of / });
    await user.click(within(nodes(panel)).getByRole("button", { name: "Ada" }));
    await user.keyboard("{Shift>}");
    await user.click(within(nodes(panel)).getByRole("button", { name: "Grace" }));
    // A product has no customerId and gives no value.
    await user.click(within(nodes(panel)).getByRole("button", { name: "Desk" }));
    await user.keyboard("{/Shift}");
    await user.click(within(panel).getByRole("button", { name: "Set $customers (2 values)" }));
    await waitFor(() =>
      expect(
        server.areas.dashboards.panelQueries.some(
          (q) => JSON.stringify(q.body.variables.customers) === JSON.stringify(["42", "43"]),
        ),
      ).toBe(true),
    );
  });

  it("cancels a step still loading when it is undone", async () => {
    const server = setup("editor", { explorer: true });
    let answer: (() => void) | undefined;
    const respond = server.areas.datasources.respond;
    // Only the expand query waits; the panel's own query answers at once.
    server.areas.datasources.respond = (item, range, variables) =>
      JSON.stringify(item.query).includes("elementId")
        ? new Promise((resolve) => {
            answer = () => resolve(respond(item, range, variables));
          })
        : respond(item, range, variables);
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    await waitFor(() => expect(answer).toBeDefined());
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    answer?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(nodes(panel)).queryByRole("button", { name: "Oak & Co" })).toBeNull();
    expect(within(panel).queryByText("Loading Desk…")).toBeNull();
  });

  it("starts over without steps when the panel's results are new", async () => {
    setup("editor", { explorer: true });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Desk" }));
    expect(await within(nodes(panel)).findByRole("button", { name: "Oak & Co" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(within(nodes(panel)).queryByRole("button", { name: "Oak & Co" })).toBeNull(),
    );
    expect(within(panel).queryByRole("button", { name: /^Desk \+/ })).toBeNull();
  });

  it("says why a viewer cannot load neighbours, and a click opens the details instead", async () => {
    setup("viewer", { explorer: true, clickDetails: false });
    const { user } = renderApp("/dashboards/d-shop");
    expect(
      await screen.findByText("Loading neighbours needs query access to the data source."),
    ).toBeTruthy();
    const panel = screen.getByRole("article", { name: "Purchases" });
    await user.click(within(nodes(panel)).getByRole("button", { name: "Desk" }));
    expect(within(panel).getByRole("region", { name: "Details of Desk" })).toBeTruthy();
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

describe("a graph panel shown alone", () => {
  it("still sets a dashboard variable from a node", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    addNeo4jSource(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-shop", {
      ...emptyModel("Shop"),
      variables: [{ name: "customerId", type: "custom", options: ["42", "43"] }],
      panels: [graphPanel({ variable: "customerId", variableProperty: "customerId" })],
    });
    const { user } = renderApp("/dashboards/d-shop?viewPanel=p-graph");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    await user.click(await within(panel).findByRole("button", { name: "Grace" }));
    // The panel queries again with the value the node set.
    await waitFor(() =>
      expect(
        server.areas.dashboards.panelQueries.some((q) => q.body.variables.customerId === "43"),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Back to the dashboard" }));
    expect(await screen.findByRole("combobox", { name: "customerId" })).toHaveProperty(
      "value",
      "43",
    );
  });
});

describe("a custom variable", () => {
  it("is set only to one of its options", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    addNeo4jSource(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-shop", {
      ...emptyModel("Shop"),
      variables: [{ name: "customerId", type: "custom", options: ["42", "44"] }],
      panels: [graphPanel({ variable: "customerId", variableProperty: "customerId" })],
    });
    const { user } = renderApp("/dashboards/d-shop");
    const panel = await screen.findByRole("article", { name: "Purchases" });
    const picker = await screen.findByRole("combobox", { name: "customerId" });
    await user.click(await within(panel).findByRole("button", { name: "Grace" }));
    expect(picker).toHaveProperty("value", "42");
    expect(within(panel).getByRole("status").textContent).toBe(
      "$customerId has no value 43, so it stays as it is.",
    );
    await user.selectOptions(picker, "44");
    await user.click(within(nodes(panel)).getByRole("button", { name: "Ada" }));
    expect(picker).toHaveProperty("value", "42");
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

describe("Explore with TigerGraph", () => {
  it("writes GSQL from a template for the source's graph, or runs an installed query", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("admin") });
    addTigerGraphSource(server.areas.datasources);
    const { user } = renderApp("/explore");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Data source" }), "Tiger");
    expect(await screen.findByRole("radio", { name: "Write GSQL" })).toHaveProperty(
      "checked",
      true,
    );
    await user.click(await screen.findByRole("button", { name: "Start from a template" }));
    const editor = screen.getByRole("textbox", { name: "Query" });
    expect((editor as HTMLTextAreaElement).value).toContain("FOR GRAPH social");

    await user.click(screen.getByRole("radio", { name: "Run an installed query" }));
    const picker = await screen.findByRole("combobox", { name: "Installed query" });
    await user.selectOptions(picker, "top_customers");
    const params = screen.getByRole("textbox", { name: "Parameters (optional)" });
    fireEvent.change(params, { target: { value: "[1]" } });
    expect(screen.getByText("Enter a JSON object, or leave the field empty.")).toBeTruthy();
    fireEvent.change(params, { target: { value: '{"limit": 5}' } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("table", { name: "Nodes of Result: 4" })).toBeTruthy();
    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(sent.queries[0]?.query).toEqual({ installed: "top_customers", params: { limit: 5 } });
  });
});
