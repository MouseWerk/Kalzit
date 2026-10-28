import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyQuery, familyOf, hasQuery } from "./queryKinds";
import type { FakeDatasourcesState, WireKind } from "./test/fakeDatasources";

const KIND = "dev.example.testplugin";

const PLUGIN_KIND: WireKind = {
  kind: KIND,
  name: "Test plugin",
  shapes: ["frame", "documents"],
  hintKey: "datasources.kinds.plugin.hint",
  settings: [
    {
      name: "host",
      labelKey: "datasources.settings.host",
      type: "string",
      required: true,
      secret: false,
      target: true,
    },
    {
      name: "warehouse",
      labelKey: "datasources.settings.warehouse",
      type: "string",
      required: false,
      secret: false,
      target: false,
    },
  ],
  plugin: {
    plugin: KIND,
    version: "1.0.0",
    publisher: "Example GmbH",
    labels: { host: { en: "Host", de: "Rechner" }, warehouse: { en: "Warehouse", de: "Lager" } },
    help: { warehouse: { en: "The warehouse queries run in." } },
  },
};

function addPluginSource(state: FakeDatasourcesState) {
  state.pluginKinds.push(PLUGIN_KIND);
  state.datasources.push({
    id: "plug1",
    name: "Lager",
    kind: KIND,
    settings: { host: "db.example.test" },
    secrets: {},
    createdAt: Date.UTC(2026, 0, 17),
    updatedAt: Date.UTC(2026, 0, 17),
  });
}

function open(path: string) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "admin" }] },
  });
  addPluginSource(server.areas.datasources);
  return { server, ...renderApp(path) };
}

describe("data sources of plugin kinds", () => {
  it("tells plugin kinds by their dotted id and edits their query as one JSON object", () => {
    expect(familyOf(KIND)).toBe("plugin");
    expect(familyOf("postgres")).toBe("sql");
    expect(emptyQuery(KIND)).toEqual({});
    expect(hasQuery({}, KIND)).toBe(true);
    expect(hasQuery({ do: "frame" }, KIND)).toBe(true);
  });

  it("offers them in their own group with a neutral publisher line", async () => {
    open("/data-sources/new");
    const group = await screen.findByRole("list", { name: /From plugins/ });
    const link = within(group).getByRole("link", { name: "Test plugin" });
    expect(link.querySelector(".kind-mark__letters")?.textContent).toBe("TP");
    expect(within(group).getByText("Plugin from Example GmbH · 1.0.0")).toBeTruthy();
    expect(screen.getByText(/signed, run in a sandbox/)).toBeTruthy();
  });

  it("labels the form with the manifest's texts and the plugin's advice", async () => {
    const { user } = open("/data-sources/new");
    await user.click(await screen.findByRole("link", { name: "Test plugin" }));
    expect(await screen.findByText(/The connection runs in the plugin’s own process/)).toBeTruthy();
    // The picker and the form's heading both name the publisher.
    expect(screen.getAllByText(/Plugin from Example GmbH · 1\.0\.0/).length).toBeGreaterThan(1);
    // A known name keeps its own translation, an unknown one takes the manifest's label.
    expect(screen.getByRole("textbox", { name: "Host" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Warehouse (optional)" })).toBeTruthy();
    expect(screen.getByText("The warehouse queries run in.")).toBeTruthy();
  });

  it("marks plugin sources in the list with the publisher", async () => {
    open("/data-sources");
    const name = await screen.findByRole("link", { name: "Lager" });
    const row = name.closest("tr") as HTMLElement;
    expect(within(row).getByText("Plugin · Example GmbH")).toBeTruthy();
    expect(within(row).getByText("Test plugin")).toBeTruthy();
  });

  it("runs a JSON query in Explore, sent as written", async () => {
    const { server, user } = open("/explore");
    const picker = await screen.findByLabelText("Data source", {}, { timeout: 4000 });
    fireEvent.change(picker, { target: { value: "plug1" } });
    const editor = await screen.findByLabelText("Query");
    fireEvent.change(editor, { target: { value: '{"do": "rows", "n": 5}' } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(
        (server.areas.datasources.queries.at(-1) as { queries: { query: unknown }[] } | undefined)
          ?.queries[0]?.query,
      ).toEqual({ do: "rows", n: 5 }),
    );
    // Text that is no object is not taken, and says why.
    fireEvent.change(editor, { target: { value: "[1]" } });
    expect(await screen.findByText(/Write the query as one JSON object/)).toBeTruthy();
  });
});
