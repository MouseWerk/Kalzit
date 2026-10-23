import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { addSourceKinds } from "../datasources/test/fakeDatasources";
import { HTTP_ID } from "../datasources/test/fakeSources";
import { emptyModel } from "./model";
import { addDashboard } from "./test/fakeDashboards";

/** The HTTP JSON query editor inside the full-page panel editor, with the real query editors. */
describe("a search, file or HTTP JSON query in the panel editor page", () => {
  it("edits the query in its own editor and does not run while the path is refused", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "editor" }],
      },
    });
    addSourceKinds(server.areas.datasources);
    addDashboard(server.areas.dashboards, "d-api", {
      ...emptyModel("API"),
      panels: [
        {
          id: "p1",
          type: "table",
          title: "Open orders",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: HTTP_ID, query: { path: "orders" } }],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    });
    const { user } = renderApp("/dashboards/d-api/panels/p1/edit");
    const editor = await screen.findByRole("region", { name: "Edit panel" });
    expect(await within(editor).findByText("Method: GET")).toBeTruthy();
    const run = within(editor).getByRole("button", { name: "Run queries" });
    const path = within(editor).getByRole("textbox", { name: "Path" });
    expect(path).toHaveProperty("value", "orders");

    fireEvent.change(path, { target: { value: "../x" } });
    expect(path.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(run).toHaveProperty("disabled", true));
    const before = server.areas.datasources.queries.length;
    await user.click(run);
    // Leaving the field runs a changed query, but not one the server would refuse.
    fireEvent.blur(path);
    expect(server.areas.datasources.queries.length).toBe(before);

    fireEvent.change(path, { target: { value: "orders/open" } });
    await waitFor(() => expect(run).toHaveProperty("disabled", false));
    await user.click(run);
    await waitFor(() =>
      expect(
        (server.areas.datasources.queries.at(-1) as unknown as QueryRequest | undefined)?.queries[0]
          ?.query,
      ).toEqual({ path: "orders/open" }),
    );
  });
});
