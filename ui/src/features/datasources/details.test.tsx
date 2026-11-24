import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_PERMISSIONS, installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { suggestSource } from "../provisioning/grafana";
import { fakeProvisioned } from "../provisioning/test/fakeProvisioning";
import { preferredSource } from "./api";
import { PG_ID, PROM_ID } from "./test/fakeDatasources";

function open(path: string, role = "admin") {
  const user = { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
  const server = installFakeServer({ signedIn: true, user });
  return { server, ...renderApp(path) };
}

type Server = ReturnType<typeof installFakeServer>;

const stored = (server: Server, id: string) =>
  server.areas.datasources.datasources.find((source) => source.id === id);

/** Fills a field at once: typing key by key is slow. */
async function fill(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

describe("a passing test in the form", () => {
  it("counts as a new source's latest test once it is saved", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    await fill(
      user,
      screen.getByRole("textbox", { name: "Absolute path of the file" }),
      "/data/a.db",
    );
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected in \d+ ms/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() => expect(location().pathname).toBe("/data-sources/ds-new-1"));
    // The stored source was tested once, so the server keeps the result as its last test.
    expect(server.areas.datasources.healthChecks).toEqual(["ds-new-1"]);
    expect(stored(server, "ds-new-1")?.lastTest?.ok).toBe(true);
    expect(server.areas.datasources.tests).toHaveLength(1);
    // The list shows it as tested, not "Not tested".
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Data sources" }));
    const row = await within(await screen.findByRole("table")).findByRole("row", {
      name: /Local/,
    });
    expect(within(row).queryByText("Not tested")).toBeNull();
    expect(within(row).getByText("Connected")).toBeTruthy();
  });

  it("does not count when the form changed after the test", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    const path = screen.getByRole("textbox", { name: "Absolute path of the file" });
    await fill(user, path, "/data/a.db");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Connected in \d+ ms/)).toBeTruthy();
    await fill(user, path, "x");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() => expect(location().pathname).toBe("/data-sources/ds-new-1"));
    expect(server.areas.datasources.healthChecks).toEqual([]);
    expect(stored(server, "ds-new-1")?.lastTest).toBeUndefined();
  });

  it("does not count when it failed", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    server.areas.datasources.testHealth = { ok: false, message: "refused", latencyMs: 2 } as never;
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    await fill(
      user,
      screen.getByRole("textbox", { name: "Absolute path of the file" }),
      "/data/a.db",
    );
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() => expect(location().pathname).toBe("/data-sources/ds-new-1"));
    expect(server.areas.datasources.healthChecks).toEqual([]);
  });

  it("counts as an edited source's latest test once the changes are saved", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await screen.findByRole("textbox", { name: "Name" });
    await user.click(screen.getByRole("button", { name: /^Limits/ }));
    await user.type(await screen.findByRole("textbox", { name: "Row limit (optional)" }), "1000");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/Tested with the settings you entered/)).toBeTruthy();
    expect(server.areas.datasources.healthChecks).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    await waitFor(() => expect(server.areas.datasources.healthChecks).toEqual([PG_ID]));
    expect(stored(server, PG_ID)?.settings.maxRows).toBe(1000);
    expect(stored(server, PG_ID)?.lastTest?.ok).toBe(true);
  });
});

describe("the default data source on a form and a managed source", () => {
  it("is sent only when its box was changed, so a save keeps a default set meanwhile", async () => {
    const { server, user } = open(`/data-sources/${PROM_ID}`);
    const name = await screen.findByRole("textbox", { name: "Name" });
    // Someone else makes it the default while the form is open.
    const prom = stored(server, PROM_ID);
    if (prom !== undefined) prom.isDefault = true;
    await user.type(name, " 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(stored(server, PROM_ID)?.name).toBe("Metrics 2");
    expect(stored(server, PROM_ID)?.isDefault).toBe(true);
    expect(
      server.calls.some((call) => call.method === "PUT" && call.path.endsWith("/default")),
    ).toBe(false);
  });

  it("stays changeable on a source the files manage, its settings read-only", async () => {
    const server = installFakeServer({
      signedIn: true,
      user: {
        ...TEST_USER,
        isServerAdmin: false,
        orgs: [{ id: "o1", name: "Org", role: "admin" }],
      },
      rolePermissions: {
        admin: [...(BUILT_IN_ROLE_PERMISSIONS.admin ?? []), "provisioning:read"],
      },
    });
    server.areas.provisioning.resources.push(
      fakeProvisioned({ kind: "datasource", uid: "metrics", resourceId: PROM_ID, name: "Metrics" }),
    );
    const { user } = renderApp(`/data-sources/${PROM_ID}`);
    await screen.findByRole("button", { name: "Managed by files" });
    const toggle = await screen.findByRole("checkbox", { name: "Default data source" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getAllByRole("checkbox", { name: "Default data source" })).toHaveLength(1);
    await user.click(toggle);
    await waitFor(() => expect(stored(server, PROM_ID)?.isDefault).toBe(true));
    expect(await screen.findByText("“Metrics” is now the default data source.")).toBeTruthy();
  });

  it("is proposed for Grafana's default source only when the importer may query it", () => {
    const grafanaDefault = { key: "default", label: "", type: "", uses: 1, variable: false };
    const queryable = [{ id: "a", kind: "postgres", name: "Lager", isDefault: true, query: true }];
    expect(suggestSource(grafanaDefault, queryable)).toEqual({ id: "a", why: "orgDefault" });
    const notQueryable = [
      { id: "a", kind: "postgres", name: "Lager", isDefault: true, query: false },
    ];
    expect(suggestSource(grafanaDefault, notQueryable).why).not.toBe("orgDefault");
  });
});

describe("the default data source", () => {
  it("is set and taken away from a row's menu, marked in the list", async () => {
    const { server, user } = open("/data-sources");
    const table = await screen.findByRole("table");
    const row = (name: RegExp) => within(screen.getByRole("table")).getByRole("row", { name });
    expect(within(table).queryByText("Default")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Actions for “Metrics”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(stored(server, PROM_ID)?.isDefault).toBe(true));
    expect(await within(row(/Metrics/)).findByText("Default")).toBeTruthy();
    expect(await screen.findByText("“Metrics” is now the default data source.")).toBeTruthy();

    // Another source takes it over.
    await user.click(screen.getByRole("button", { name: "Actions for “Sales DB”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Make default" }));
    await waitFor(() => expect(stored(server, PG_ID)?.isDefault).toBe(true));
    expect(stored(server, PROM_ID)?.isDefault).toBe(false);
    await waitFor(() => expect(within(row(/Metrics/)).queryByText("Default")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Actions for “Sales DB”" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove as default" }));
    await waitFor(() => expect(stored(server, PG_ID)?.isDefault).toBe(false));
  });

  it("is offered on the form to who may change the source, and saved with it", async () => {
    const { server, user } = open(`/data-sources/${PROM_ID}`);
    const toggle = await screen.findByRole("checkbox", { name: "Default data source" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(stored(server, PROM_ID)?.isDefault).toBe(true));
    expect(
      server.calls.some((call) => call.method === "PUT" && call.path.endsWith("/default")),
    ).toBe(true);
  });

  it("is not offered to who may only use the source", async () => {
    open(`/data-sources/${PG_ID}`, "editor");
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.queryByRole("checkbox", { name: "Default data source" })).toBeNull();
  });

  it("is what new work starts with when nothing is chosen", () => {
    const a: { id: string; isDefault?: boolean } = { id: "a" };
    const b = { id: "b", isDefault: true };
    expect(preferredSource([a, b])).toBe(b);
    expect(preferredSource([a])).toBe(a);
    expect(preferredSource([])).toBeUndefined();
  });
});
