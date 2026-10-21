import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "../dashboards/model";
import { addDashboard, latest } from "../dashboards/test/fakeDashboards";
import { PG_ID, PROM_ID } from "../datasources/test/fakeDatasources";

function open(role = "editor") {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] },
  });
  return { server, ...renderApp("/explore") };
}

async function runSql(user: ReturnType<typeof open>["user"], sql: string) {
  const editor = await screen.findByRole("textbox", { name: "Query" });
  fireEvent.change(editor, { target: { value: sql } });
  await user.click(screen.getByRole("button", { name: "Run query" }));
}

describe("Explore", () => {
  it("is not there for viewers", async () => {
    open("viewer");
    expect(
      await screen.findByRole("heading", { name: "Explore is not available to your role" }),
    ).toBeTruthy();
  });

  it("runs a query with an absolute time range and shows the result in a matching panel", async () => {
    const { server, user } = open();
    await screen.findByRole("combobox", { name: "Data source" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "table");
    const before = Date.now();
    await runSql(user, "SELECT * FROM customers");
    expect(await screen.findByText("Grace")).toBeTruthy();
    // A table result without time opens as a table, with int64 exact.
    expect(screen.getByText("9007199254740993")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Visualization" })).toHaveProperty(
      "value",
      "table",
    );

    const sent = server.areas.datasources.queries.at(-1) as QueryRequest;
    expect(sent.queries).toEqual([
      {
        refId: "A",
        datasourceId: PG_ID,
        query: { sql: "SELECT * FROM customers", format: "table" },
      },
    ]);
    expect(sent.timeRange.to).toBeGreaterThanOrEqual(before);
    expect(sent.timeRange.to - sent.timeRange.from).toBe(3_600_000);
  });

  it("shows the executed query, notices and truncation in the inspector", async () => {
    const { server, user } = open();
    server.areas.datasources.respond = () => ({
      result: {
        shape: "frame",
        frame: {
          fields: [{ name: "n", type: "number", values: [1, 2] }],
          meta: {
            executedQuery: "SELECT n FROM t WHERE ts BETWEEN $1 AND $2",
            rowsTruncated: true,
            notices: [{ severity: "warning", text: "Index not used" }],
          },
        },
      },
    });
    await runSql(user, "SELECT n FROM t WHERE $__timeFilter(ts)");
    expect(await screen.findByText(/cut off at the row limit/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Inspect" }));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("SELECT n FROM t WHERE ts BETWEEN $1 AND $2")).toBeTruthy();
    expect(within(panel).getByText(/Index not used/)).toBeTruthy();
    expect(within(panel).getByText("2 rows, 1 fields")).toBeTruthy();
  });

  it("maps a query error to its text", async () => {
    const { user } = open();
    await runSql(user, "DELETE FROM t -- fail:query_rejected");
    expect(await screen.findByText(/rejected because it could change data/)).toBeTruthy();
  });

  it("switches the editor with the data source", async () => {
    const { user } = open();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Data source" }), PROM_ID);
    expect(screen.getByRole("checkbox", { name: /Instant query/ })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Format" })).toBeNull();
  });

  it("adds the query as a panel to an existing dashboard", async () => {
    const { server, user, location } = open();
    addDashboard(server.areas.dashboards, "d-ops", emptyModel("Operations"));
    await runSql(user, "SELECT 1");
    await screen.findByText("Grace");
    await user.click(screen.getByRole("button", { name: "Add to dashboard…" }));
    const dialog = screen.getByRole("dialog", { name: "Add to dashboard" });
    await user.selectOptions(
      await within(dialog).findByRole("combobox", { name: "Dashboard" }),
      "d-ops",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add panel" }));

    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-ops"));
    const saved = latest(server.areas.dashboards.dashboards[0] as never);
    expect(saved.message).toBe("Panel added from Explore");
    expect(saved.model.panels).toHaveLength(1);
    expect(saved.model.panels[0]).toMatchObject({
      type: "table",
      targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT 1", format: "table" } }],
    });
  });
});
