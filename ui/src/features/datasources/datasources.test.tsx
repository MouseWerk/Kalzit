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

type Server = ReturnType<typeof installFakeServer>;

const lastCall = (server: Server, method: string, part: string) =>
  server.calls.filter((call) => call.method === method && call.path.includes(part)).at(-1);

async function pickKind(user: ReturnType<typeof open>["user"], name: string) {
  await user.click(await screen.findByRole("link", { name }));
  await screen.findByRole("textbox", { name: "Name" });
}

describe("data source list", () => {
  it("lists data sources with their kind and offers to add one to admins", async () => {
    open("/data-sources");
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "Sales DB" })).toBeTruthy();
    expect(within(table).getByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add data source" })).toBeTruthy();
  });

  it("pages through a long list with the cursor", async () => {
    const { server, user } = open("/data-sources");
    for (let i = 0; i < 60; i++) {
      server.areas.datasources.datasources.push({
        id: `ds-${i}`,
        name: `Source ${String(i).padStart(2, "0")}`,
        kind: "sqlite",
        settings: { path: `/data/${i}.db` },
        secrets: {},
        createdAt: Date.UTC(2026, 5, 1) + i,
        updatedAt: Date.UTC(2026, 5, 1) + i,
      });
    }
    const table = await screen.findByRole("table");
    // The first page has the server's default of 50 rows plus the header.
    expect(within(table).getAllByRole("row")).toHaveLength(51);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(63));
    expect(lastCall(server, "GET", "/datasources?")?.path).toContain("cursor=50");
  });

  it("lets editors read the list and test a connection, but not change sources", async () => {
    const { server, user } = open("/data-sources", "editor");
    const table = await screen.findByRole("table");
    expect(within(table).queryByRole("link", { name: "Sales DB" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add data source" })).toBeNull();
    server.areas.datasources.health[PG_ID] = {
      ok: false,
      message: "password authentication failed",
      latencyMs: 40,
      code: "datasource_error",
    };
    await user.click(screen.getByRole("button", { name: "Test connection of “Sales DB”" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    expect(screen.getByText(/The data source reported an error/)).toBeTruthy();
    expect(screen.getByText("password authentication failed")).toBeTruthy();
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
  it("starts from the kind's defaults and sends them, with secrets only in secrets", async () => {
    const { server, user, location } = open("/data-sources/new");
    await pickKind(user, "PostgreSQL");
    expect(screen.getByText(/pg_read_all_data/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Port (optional)" })).toHaveProperty(
      "value",
      "5432",
    );
    expect(screen.getByRole("combobox", { name: "TLS mode" })).toHaveProperty("value", "prefer");
    expect(screen.getByRole("textbox", { name: "CA certificate (PEM) (optional)" }).tagName).toBe(
      "TEXTAREA",
    );

    await user.click(screen.getByRole("button", { name: "Add data source" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(lastCall(server, "POST", "/datasources")).toBeUndefined();

    await user.type(name, "Warehouse");
    await user.type(screen.getByRole("textbox", { name: "Host" }), "db.example.com");
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
        sslMode: "prefer",
      },
      secrets: { password: "pw" },
    });
    expect(await screen.findByText("Set")).toBeTruthy();
    expect(screen.queryByDisplayValue("pw")).toBeNull();
  });

  it("keeps encryption on for SQL Server when the form is left untouched", async () => {
    const { server, user } = open("/data-sources/new?kind=mssql");
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.getByRole("checkbox", { name: "Encrypt the connection" })).toHaveProperty(
      "checked",
      true,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), "ERP");
    await user.type(screen.getByRole("textbox", { name: "Host" }), "sql.internal");
    await user.type(screen.getByRole("textbox", { name: "Database" }), "erp");
    await user.type(screen.getByRole("textbox", { name: "User name" }), "reader");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() =>
      expect(lastCall(server, "POST", "/datasources")?.body).toMatchObject({
        settings: { encrypt: true, trustServerCertificate: false, port: 1433 },
      }),
    );
  });

  it("offers exactly the Prometheus fields of the kind", async () => {
    const { user } = open("/data-sources/new");
    await pickKind(user, "Prometheus");
    for (const label of [
      "URL",
      "Basic auth user name (optional)",
      "Query time limit in seconds (optional)",
    ]) {
      expect(screen.getByRole("textbox", { name: label })).toBeTruthy();
    }
    expect(screen.getByLabelText("Bearer token (optional)").getAttribute("type")).toBe("password");
    expect(screen.getByLabelText("Basic auth password (optional)").getAttribute("type")).toBe(
      "password",
    );
    expect(screen.queryByText(/Access token|certificate check/)).toBeNull();
  });

  it("asks for whole numbers and shows refused targets and taken names at their fields", async () => {
    const { user } = open("/data-sources/new?kind=postgres");
    const name = await screen.findByRole("textbox", { name: "Name" });
    const port = screen.getByRole("textbox", { name: "Port (optional)" });
    await user.clear(port);
    await user.type(port, "54.3");
    await user.type(name, "Sales DB");
    await user.type(screen.getByRole("textbox", { name: "Host" }), "169.254.169.254");
    await user.type(screen.getByRole("textbox", { name: "Database" }), "d");
    await user.type(screen.getByRole("textbox", { name: "User name" }), "u");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    expect(screen.getByText("Enter a whole number of 0 or more.")).toBeTruthy();

    await user.clear(port);
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    const host = screen.getByRole("textbox", { name: "Host" });
    await waitFor(() => expect(host.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText(/does not allow connections to this address/)).toBeTruthy();

    await user.clear(host);
    await user.type(host, "db.internal");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
    expect(
      screen.getByText("Another data source already has this name. Choose a different one."),
    ).toBeTruthy();
  });
});

describe("editing a data source", () => {
  it("keeps, replaces or removes a secret, without any version in the patch", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    expect(await screen.findByText("Set")).toBeTruthy();
    // The stored TLS mode is shown, not the default.
    expect(screen.getByRole("combobox", { name: "TLS mode" })).toHaveProperty(
      "value",
      "verify-full",
    );
    const host = screen.getByRole("textbox", { name: "Host" });
    await user.clear(host);
    await user.type(host, "db2.internal");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const first = lastCall(server, "PATCH", PG_ID)?.body as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(["name", "secrets", "settings"]);
    expect(first.secrets).toEqual({});

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Will be removed on save")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({ secrets: { password: null } }),
    );
    expect(server.areas.datasources.datasources[0]?.secrets).toEqual({});

    await user.type(await screen.findByLabelText("Password (optional)"), "new-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
        secrets: { password: "new-secret" },
      }),
    );
  });

  it("tests the connection, saving unsaved changes first", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 12 ms")).toBeTruthy();
    expect(screen.getByText("PostgreSQL 17.2")).toBeTruthy();

    server.areas.datasources.health[PG_ID] = {
      ok: false,
      message: "no route to host",
      latencyMs: 3,
      code: "datasource_target_blocked",
    };
    await user.type(screen.getByRole("textbox", { name: "Database" }), "x");
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    expect(screen.getByText(/does not allow connections to this address/)).toBeTruthy();
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
      settings: { database: "salesx" },
    });
  });

  it("moves a data source to the trash, lists it there and restores it", async () => {
    const { server, user, location } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete data source?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText(/The data source moved to the trash/);
    expect(location().pathname).toBe("/data-sources");
    expect(screen.queryByRole("link", { name: "Sales DB" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "Trash" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Data source trash" }),
    ).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Restore “Sales DB”" }));
    await waitFor(() => expect(server.areas.datasources.datasources[0]?.deletedAt).toBeUndefined());
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
  });
});
