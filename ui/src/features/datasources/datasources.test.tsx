import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "./test/fakeDatasources";

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function open(path: string, role = "admin") {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  return { server, ...renderApp(path) };
}

const lastCall = (server: ReturnType<typeof installFakeServer>, method: string, part: string) =>
  server.calls.filter((call) => call.method === method && call.path.includes(part)).at(-1);

describe("data source list", () => {
  it("lists data sources with their kind and offers to add one to admins", async () => {
    open("/data-sources");
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "Sales DB" })).toBeTruthy();
    expect(within(table).getByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add data source" })).toBeTruthy();
  });

  it("lets editors read the list but not change it", async () => {
    open("/data-sources", "editor");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Sales DB")).toBeTruthy();
    expect(within(table).queryByRole("link", { name: "Sales DB" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add data source" })).toBeNull();
  });

  it("hides the area from viewers and explains it on direct access", async () => {
    open("/data-sources", "viewer");
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByRole("link", { name: "Data sources" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Explore" })).toBeNull();
  });
});

describe("adding a data source", () => {
  it("renders the form from the kind, checks required fields and sends secrets only once", async () => {
    const { server, user, location } = open("/data-sources/new");
    await user.click(await screen.findByRole("link", { name: "PostgreSQL" }));
    expect(await screen.findByText(/Use a database login that can only read/)).toBeTruthy();
    expect(screen.getByText(/pg_read_all_data/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add data source" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(lastCall(server, "POST", "/datasources")).toBeUndefined();

    await user.type(name, "Warehouse");
    await user.type(screen.getByRole("textbox", { name: "Host" }), "db.example.com");
    await user.type(screen.getByRole("textbox", { name: "Port (optional)" }), "5432");
    await user.type(screen.getByRole("textbox", { name: "Database" }), "dwh");
    await user.type(screen.getByRole("textbox", { name: "User name" }), "kalzit_reader");
    await user.type(screen.getByLabelText("Password (optional)"), "pw");
    await user.click(screen.getByRole("button", { name: "Add data source" }));

    await screen.findByRole("heading", { level: 1, name: "Data source" });
    expect(location().pathname).toBe("/data-sources/ds-new-1");
    expect(lastCall(server, "POST", "/datasources")?.body).toEqual({
      name: "Warehouse",
      kind: "postgres",
      settings: {
        host: "db.example.com",
        port: 5432,
        database: "dwh",
        user: "kalzit_reader",
        sslMode: "require",
      },
      secrets: { password: "pw" },
    });
    // The stored password is never shown again, only that it is set.
    expect(await screen.findByText("Set")).toBeTruthy();
    expect(screen.queryByDisplayValue("pw")).toBeNull();
  });
});

describe("editing a data source", () => {
  it("keeps, replaces or removes a secret with the patch semantics of the API", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    expect(await screen.findByText("Set")).toBeTruthy();
    const host = screen.getByRole("textbox", { name: "Host" });
    await user.clear(host);
    await user.type(host, "db2.internal");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    // Omitted means keep.
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({ version: 1, secrets: {} });

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Will be removed on save")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
        version: 2,
        secrets: { password: null },
      }),
    );
    expect(server.areas.datasources.datasources[0]?.secrets).toEqual({});

    await user.type(await screen.findByLabelText("Password (optional)"), "new-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
        version: 3,
        secrets: { password: "new-secret" },
      }),
    );
  });

  it("tests the connection and shows the result, saving unsaved changes first", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 12 ms")).toBeTruthy();
    expect(screen.getByText("PostgreSQL 17.2")).toBeTruthy();

    server.areas.datasources.health[PG_ID] = {
      ok: false,
      message: "password authentication failed",
      latencyMs: 3,
    };
    await user.type(screen.getByRole("textbox", { name: "Database" }), "x");
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    expect(screen.getByText("password authentication failed")).toBeTruthy();
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
      settings: { database: "salesx" },
    });
  });

  it("explains a version conflict and reloads", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await screen.findByText("Set");
    const stored = server.areas.datasources.datasources[0];
    if (stored !== undefined) {
      stored.version = 5;
    }
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Someone else changed this data source/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByText(/Someone else changed/)).toBeNull());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({ version: 5 }),
    );
  });

  it("moves a data source to the trash after confirmation and restores it", async () => {
    const { server, user, location } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete data source?" });
    // Destructive confirmations start on Cancel.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText(/The data source moved to the trash/);
    expect(location().pathname).toBe("/data-sources");
    expect(screen.queryByRole("link", { name: "Sales DB" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("link", { name: "Sales DB" })).toBeTruthy();
    expect(server.areas.datasources.datasources[0]?.deletedAt).toBeUndefined();
  });
});
