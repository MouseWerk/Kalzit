import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID, PROM_ID } from "./test/fakeDatasources";

/** Fills a field at once: typing key by key is slow, and these tests check what is sent. */
async function fill(user: ReturnType<typeof renderApp>["user"], field: HTMLElement, text: string) {
  await user.click(field);
  await user.paste(text);
}

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

  it("shows viewers without a grant an empty list and no Explore", async () => {
    open("/data-sources", "viewer");
    // The server lists only what the caller may read, so a viewer without a grant sees nothing.
    expect(await screen.findByRole("heading", { name: "No data sources yet" })).toBeTruthy();
    expect(screen.getByText(/the data sources your role or access given to you/)).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Data sources" })).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Explore" })).toBeNull();
  });

  it("lists a source granted to a viewer and nothing else", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PG_ID] = "query";
    renderApp("/data-sources");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Sales DB")).toBeTruthy();
    expect(within(table).queryByText("Metrics")).toBeNull();
  });

  it("lets a viewer with an edit grant change and test that one source", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PG_ID] = "edit";
    renderApp("/data-sources");
    const table = await screen.findByRole("table");
    // The source's own `access` decides, not the viewer role.
    expect(within(table).getByRole("link", { name: "Sales DB" })).toBeTruthy();
    expect(
      within(table).getByRole("button", { name: "Test connection of “Sales DB”" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Trash" })).toBeTruthy();
    // Adding a source stays an org-wide right.
    expect(screen.queryByRole("link", { name: "Add data source" })).toBeNull();
  });

  it("shows Explore in the nav to a viewer with only a query grant, from cached data", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PG_ID] = "query";
    const { user } = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(await within(nav).findByRole("link", { name: "Explore" })).toBeTruthy();
    const lists = () =>
      server.calls.filter((c) => c.method === "GET" && /\/datasources(\?|$)/.test(c.path)).length;
    const before = lists();
    // Moving through the app renders the shell again; the list is not fetched again.
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await user.click(within(nav).getByRole("link", { name: "Explore" }));
    await screen.findByRole("combobox", { name: "Data source" });
    expect(lists()).toBe(before);
  });

  it("opens Explore for a viewer with a query grant, with only that source", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PG_ID] = "query";
    renderApp("/explore");
    const picker = await screen.findByRole("combobox", { name: "Data source" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Sales DB"]);
  });

  it("follows the org role when the server sends no access flags", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PG_ID] = "edit";
    server.areas.datasources.sendAccess = false;
    renderApp("/data-sources");
    const table = await screen.findByRole("table");
    expect(within(table).queryByRole("link", { name: "Sales DB" })).toBeNull();
    expect(within(table).getByText("Sales DB")).toBeTruthy();
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

    await fill(user, name, "Warehouse");
    await fill(user, screen.getByRole("textbox", { name: "Host" }), "db.example.com");
    await fill(user, screen.getByRole("textbox", { name: "Database" }), "dwh");
    await fill(user, screen.getByRole("textbox", { name: "User name" }), "kalzit_reader");
    await fill(user, screen.getByLabelText("Password (optional)"), "pw");
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
    await fill(user, screen.getByRole("textbox", { name: "Name" }), "ERP");
    await fill(user, screen.getByRole("textbox", { name: "Host" }), "sql.internal");
    await fill(user, screen.getByRole("textbox", { name: "Database" }), "erp");
    await fill(user, screen.getByRole("textbox", { name: "User name" }), "reader");
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
    await fill(user, port, "54.3");
    await fill(user, name, "Sales DB");
    await fill(user, screen.getByRole("textbox", { name: "Host" }), "169.254.169.254");
    await fill(user, screen.getByRole("textbox", { name: "Database" }), "d");
    await fill(user, screen.getByRole("textbox", { name: "User name" }), "u");
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
  it("renames without sending settings, also for a source stored without defaults", async () => {
    const { server, user } = open("/data-sources/ds-lean");
    server.areas.datasources.datasources.push({
      id: "ds-lean",
      name: "Lean",
      kind: "postgres",
      // Stored without port and sslMode: the form shows their defaults, which are no change.
      settings: { host: "db.internal", database: "shop", user: "reader" },
      secrets: { password: "s3cret" },
      createdAt: 1,
      updatedAt: 1,
    });
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Shop");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(lastCall(server, "PATCH", "ds-lean")?.body).toEqual({ name: "Shop", secrets: {} });
    const stored = server.areas.datasources.datasources.find((d) => d.id === "ds-lean");
    expect(stored?.settings).toEqual({ host: "db.internal", database: "shop", user: "reader" });
    expect(stored?.secrets).toEqual({ password: "s3cret" });
  });

  it("asks for stored secrets again when the target changes, as the contract requires", async () => {
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
    // Nothing is sent: the password field asks to be entered again.
    const password = await screen.findByLabelText("Password (optional)");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(/The connection target changed/)).toBeTruthy();
    expect(lastCall(server, "PATCH", PG_ID)).toBeUndefined();

    await user.type(password, "new-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
      settings: { host: "db2.internal", port: 5432, sslMode: "verify-full" },
      secrets: { password: "new-secret" },
    });
  });

  it("locks the target fields for an edit grant and still saves the name", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PROM_ID] = "edit";
    const { user } = renderApp(`/data-sources/${PROM_ID}`);
    const url = await screen.findByRole("textbox", { name: "URL" });
    expect(url).toHaveProperty("disabled", true);
    expect(screen.getByText(/only a data source admin can change/)).toBeTruthy();
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveProperty("disabled", false);
    await user.clear(name);
    await user.paste("Metrics 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(server.areas.datasources.datasources.find((d) => d.id === PROM_ID)?.name).toBe(
      "Metrics 2",
    );
    // Write includes moving it to the trash; managing access needs admin rights on it.
    expect(screen.getByRole("button", { name: "Delete…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Access…" })).toBeNull();
  });

  it("unlocks the target with changeTarget, independent of managing access", async () => {
    // A custom role that may change sources but not their grants.
    installFakeServer({
      signedIn: true,
      user: asRole("maintainer"),
      rolePermissions: { maintainer: ["datasources:read", "datasources:write"] },
    });
    renderApp(`/data-sources/${PROM_ID}`);
    const url = await screen.findByRole("textbox", { name: "URL" });
    expect(url).toHaveProperty("disabled", false);
    expect(screen.queryByText(/only a data source admin can change/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Access…" })).toBeNull();
  });

  it("says what a refused SQLite path needs", async () => {
    const { server, user } = open("/data-sources/ds-lite");
    server.areas.datasources.datasources.push({
      id: "ds-lite",
      name: "Shop",
      kind: "sqlite",
      settings: { path: "/data/shop.db" },
      secrets: {},
      createdAt: 1,
      updatedAt: 1,
    });
    const path = await screen.findByRole("textbox", { name: "Absolute path of the database file" });
    // The fake refuses files outside /data with the reason target.sqlite_path_refused.
    await user.clear(path);
    await user.paste("/etc/shadow.db");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/folder the server admin allowed for SQLite/)).toBeTruthy();
  });

  it("explains a target change refused after the admin grant was lowered", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.grants[PROM_ID] = "admin";
    const { user } = renderApp(`/data-sources/${PROM_ID}`);
    // The name is no target, so the edit grant is enough for it.
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await fill(user, name, "Metrics 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    // The saved source loads again into a fresh form; meanwhile an admin lowers the grant.
    const url = await screen.findByRole("textbox", { name: "URL" });
    server.areas.datasources.grants[PROM_ID] = "edit";
    await user.clear(url);
    await fill(user, url, "http://prometheus-2:9090");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/but not where it connects/)).toBeTruthy();
    expect(server.areas.datasources.datasources.find((d) => d.id === PROM_ID)?.name).toBe(
      "Metrics 2",
    );
  });

  it("removes a secret without touching the settings", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText("Will be removed on save")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(lastCall(server, "PATCH", PG_ID)?.body).toEqual({
        name: "Sales DB",
        secrets: { password: null },
      }),
    );
    expect(server.areas.datasources.datasources[0]?.secrets).toEqual({});
  });

  it("shows the server's demand for a secret it stored in the meantime at that field", async () => {
    const { server, user } = open("/data-sources/ds-prom");
    const url = await screen.findByRole("textbox", { name: "URL" });
    // Someone else stored a token after this page loaded; the page does not know it.
    const prom = server.areas.datasources.datasources.find((d) => d.id === "ds-prom");
    if (prom !== undefined) {
      prom.secrets.bearerToken = "t0k3n";
    }
    await user.clear(url);
    await fill(user, url, "http://prometheus-2:9090");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const token = await screen.findByLabelText("Bearer token (optional)");
    await waitFor(() => expect(token.getAttribute("aria-invalid")).toBe("true"));
    expect(screen.getByText(/The connection target changed/)).toBeTruthy();
  });

  it("tests the connection, saving unsaved changes first", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Connected in 12 ms")).toBeTruthy();
    // The health reason with its params, in the UI's language.
    expect(screen.getByText("Connected to PostgreSQL 17.2.")).toBeTruthy();

    server.areas.datasources.health[PG_ID] = {
      ok: false,
      message: "no route to host",
      latencyMs: 3,
      code: "datasource_target_blocked",
    };
    // The row limit is no target, so no secret has to be entered again.
    await user.type(screen.getByRole("textbox", { name: "Row limit (optional)" }), "1000");
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    expect(screen.getByText(/does not allow connections to this address/)).toBeTruthy();
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
      settings: { maxRows: 1000, host: "db.internal" },
      secrets: {},
    });
  });

  it("moves a data source to the trash, lists it there and restores it", async () => {
    const { server, user, location } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete data source?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    const before = server.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await screen.findByText(/The data source moved to the trash/);
    expect(location().pathname).toBe("/data-sources");
    // The page of the deleted source does not load it again on the way out: that request
    // could only answer 404 and would flash "not found" before the list appears.
    const reloads = server.calls
      .slice(before)
      .filter((call) => call.method === "GET" && call.path.includes(`/datasources/${PG_ID}`));
    expect(reloads).toEqual([]);
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
