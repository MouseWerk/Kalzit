import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { addSourceKinds, PG_ID } from "../datasources/test/fakeDatasources";
import { ES_ID, FILE_ID, HTTP_ID } from "../datasources/test/fakeSources";

function open(id: string, role = "editor") {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
  });
  addSourceKinds(server.areas.datasources);
  const app = renderApp("/explore");
  return { server, ...app, ready: choose(app.user, id) };
}

async function choose(user: ReturnType<typeof renderApp>["user"], id: string) {
  await user.selectOptions(await screen.findByRole("combobox", { name: "Data source" }), id);
}

const lastQuery = (server: ReturnType<typeof installFakeServer>) =>
  (server.areas.datasources.queries.at(-1) as unknown as QueryRequest).queries[0]?.query;

describe("Explore with an Elasticsearch source", () => {
  it("sends a Lucene search with index and size exactly in the search form", async () => {
    const { server, user, ready } = open(ES_ID);
    await ready;
    // The source's default index is the placeholder; the schema's indices are offered.
    const index = await screen.findByRole("combobox", { name: "Index or pattern" });
    expect(index.getAttribute("placeholder")).toBe("logs-*");
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), {
      target: { value: "status:500" },
    });
    fireEvent.change(index, { target: { value: "logs-2026.03" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Number of hits" }), {
      target: { value: "1" },
    });
    expect(screen.getByText("Result: the hits as documents.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("region", { name: "Result" });
    expect(lastQuery(server)).toEqual({ lucene: "status:500", index: "logs-2026.03", size: 1 });
  });

  it("runs an empty search: it matches every document in the time range", async () => {
    const { server, user, ready } = open(ES_ID);
    await ready;
    const run = screen.getByRole("button", { name: "Run query" });
    expect(run).toHaveProperty("disabled", false);
    await user.click(run);
    await waitFor(() => expect(lastQuery(server)).toEqual({ lucene: "" }));
  });

  it("switches to Query DSL, applies a template, and draws aggregations as a table", async () => {
    const { server, user, ready } = open(ES_ID);
    await ready;
    fireEvent.change(await screen.findByRole("textbox", { name: "Query" }), {
      target: { value: "land:AT" },
    });
    await user.click(screen.getByRole("radio", { name: "Query DSL" }));
    // The Lucene text moves into the body, visibly.
    const body = screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement;
    expect(JSON.parse(body.value)).toEqual({ query: { query_string: { query: "land:AT" } } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Start from a template" }),
      "terms",
    );
    expect(screen.getByText("The template replaced the query.")).toBeTruthy();
    expect(screen.getByText(/Result: a table/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Number of hits" })).toHaveProperty(
      "disabled",
      true,
    );
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("doc_count")).toBeTruthy();
    expect(lastQuery(server)).toEqual({
      dsl: { aggs: { land: { terms: { field: "land", size: 10 } } } },
    });
    // Undo brings the body before the template back.
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      JSON.parse((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value),
    ).toEqual({ query: { query_string: { query: "land:AT" } } });
  });

  it("says why an index or a body would be refused, in the server's words", async () => {
    const { ready } = open(ES_ID);
    await ready;
    const index = await screen.findByRole("combobox", { name: "Index or pattern" });
    fireEvent.change(index, { target: { value: "_all" } });
    expect(index.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/_all is not an index name or pattern/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("radio", { name: "Query DSL" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), {
      target: { value: '{"script": {}}' },
    });
    expect(screen.getByText(/script is not allowed in a search/)).toBeTruthy();
  });

  it("shows a refusal the server answers with its translated reason", async () => {
    const { server, user, ready } = open(ES_ID);
    // A source without a default index: the query must name one.
    const source = server.areas.datasources.datasources.find((d) => d.id === ES_ID);
    if (source !== undefined) source.settings = { url: "https://search.internal:9200" };
    await ready;
    expect(
      await screen.findByText("Name an index, in the query or in the data source’s settings."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    const alerts = await screen.findAllByText(
      "Name an index, in the query or in the data source’s settings.",
    );
    expect(alerts.length).toBe(2);
  });
});

describe("Explore with a CSV file source", () => {
  it("shows how the file is read and runs it with the query {}", async () => {
    const { server, user, ready } = open(FILE_ID);
    await ready;
    expect(await screen.findByText("/data/files/sales.csv")).toBeTruthy();
    expect(screen.getByText("Semicolon")).toBeTruthy();
    expect(screen.getByText("Columns (2)")).toBeTruthy();
    expect(screen.getByText("region")).toBeTruthy();
    // Editors may not change the source, so no way there is offered.
    expect(screen.queryByRole("link", { name: /Change the file/ })).toBeNull();
    const run = screen.getByRole("button", { name: "Run query" });
    expect(run).toHaveProperty("disabled", false);
    await user.click(run);
    expect(await screen.findByText("Nord")).toBeTruthy();
    expect(lastQuery(server)).toEqual({});
  });
});

describe("Explore with a CSV file source, for an admin", () => {
  it("leads to the source's settings to change the file", async () => {
    const { ready } = open(FILE_ID, "admin");
    await ready;
    const link = await screen.findByRole("link", { name: /Change the file/ });
    expect(link.getAttribute("href")).toBe(`/data-sources/${FILE_ID}`);
  });
});

describe("Explore with an HTTP JSON source", () => {
  it("sends path, parameters and the documents path exactly, and previews the request", async () => {
    const { server, user, ready } = open(HTTP_ID);
    await ready;
    expect(await screen.findByText("Method: GET")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Path" }), {
      target: { value: "orders/open" },
    });
    await user.click(screen.getByRole("button", { name: "Add parameter" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of parameter 1" }), {
      target: { value: "limit" },
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Type of parameter 1" }),
      "number",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Value of parameter 1" }), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Path to the documents" }), {
      target: { value: "items" },
    });
    expect(screen.getByText("GET https://api.internal/v1/orders/open?limit=10")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("region", { name: "Result" });
    expect(lastQuery(server)).toEqual({
      path: "orders/open",
      params: { limit: 10 },
      documentsPath: "items",
    });
  });

  it("does not run while the path is refused, and shows a missing variable's reason", async () => {
    const { server, user, ready } = open(HTTP_ID);
    await ready;
    const run = screen.getByRole("button", { name: "Run query" });
    const path = await screen.findByRole("textbox", { name: "Path" });
    fireEvent.change(path, { target: { value: "orders" } });
    fireEvent.change(path, { target: { value: "../x" } });
    expect(path.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/The path must lie below the data source’s URL/)).toBeTruthy();
    // The last valid path is not run behind the user's back: Run waits for a fix.
    expect(run).toHaveProperty("disabled", true);
    fireEvent.keyDown(path, { key: "Enter", ctrlKey: true });
    expect(server.areas.datasources.queries).toHaveLength(0);
    fireEvent.change(path, { target: { value: "" } });
    expect(run).toHaveProperty("disabled", false);

    await user.click(screen.getByRole("button", { name: "Add parameter" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of parameter 1" }), {
      target: { value: "land" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Value of parameter 1" }), {
      target: { value: "$land" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("The variable land has no value.")).toBeTruthy();
  });
});

describe("dashboard panels of these sources", () => {
  it("say a SQL target stored as {} has no query yet", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "editor" }],
      },
    });
    addDashboard(server.areas.dashboards, "d-sql", {
      ...emptyModel("SQL"),
      panels: [
        {
          id: "p-sql",
          type: "table",
          title: "Unfinished",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: PG_ID, query: {} }],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    });
    renderApp("/dashboards/d-sql");
    expect(await screen.findByText("Unfinished")).toBeTruthy();
    expect(await screen.findByText("This panel has no query yet.")).toBeTruthy();
  });

  it("run a stored {} query instead of saying the panel has no query", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "viewer" }],
      },
    });
    addSourceKinds(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-file", {
      ...emptyModel("File"),
      panels: [
        {
          id: "p-file",
          type: "table",
          title: "From the file",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: FILE_ID, query: {} }],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    });
    renderApp("/dashboards/d-file");
    const panel = await screen.findByRole("region", { name: "From the file" });
    expect(await within(panel).findByText("Nord")).toBeTruthy();
    expect(within(panel).queryByText("This panel has no query yet.")).toBeNull();
  });
});
