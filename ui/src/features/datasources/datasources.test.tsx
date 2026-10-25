import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { fakeAdmin } from "../admin/test/fakeAdmin";
import { FAKE_KINDS, PG_ID, PROM_ID } from "./test/fakeDatasources";

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

/** Opens a closed section of the form by its title (its name also holds the summary). */
async function openSection(user: ReturnType<typeof open>["user"], title: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
}

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
    const row = within(table).getByRole("row", { name: /Sales DB/ });
    expect(await within(row).findByText("Unreachable")).toBeTruthy();
    // The side panel tells why.
    await user.click(within(row).getByRole("button", { name: "Details of “Sales DB”" }));
    const panel = await screen.findByRole("complementary", { name: "Sales DB" });
    expect(within(panel).getByText("The connection failed")).toBeTruthy();
    expect(within(panel).getByText(/The data source reported an error/)).toBeTruthy();
    expect(within(panel).getByText("password authentication failed")).toBeTruthy();
    // Editors query but do not change the source: no edit link, no access tab.
    expect(within(panel).queryByRole("link", { name: "Edit" })).toBeNull();
    expect(within(panel).queryByRole("tab", { name: "Access" })).toBeNull();
  });

  it("shows status tiles and filters the list by search, kind and status", async () => {
    const { server, user } = open("/data-sources");
    server.areas.datasources.health[PG_ID] = { ok: true, message: "", latencyMs: 12 };
    server.areas.datasources.health[PROM_ID] = { ok: true, message: "", latencyMs: 840 };
    const table = await screen.findByRole("table");
    const tiles = screen.getByRole("region", { name: "Status overview" });
    expect(within(tiles).getAllByText("Not tested yet")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Test all" }));
    await waitFor(() =>
      expect(within(tiles).getByRole("button", { name: /Slow/ }).textContent).toContain(
        "Metrics · 840 ms",
      ),
    );
    expect(within(tiles).getByRole("button", { name: /Connected/ }).textContent).toContain(
      "Median",
    );
    expect(await screen.findByText("Tested 2 data sources.")).toBeTruthy();

    // A status tile filters by its status, and again shows everything.
    const source = (name: string) => screen.queryByRole("link", { name });
    await user.click(within(tiles).getByRole("button", { name: /Slow/ }));
    expect(source("Sales DB")).toBeNull();
    expect(source("Metrics")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(source("Sales DB")).toBeTruthy();

    // Kind groups and search.
    await user.click(screen.getByRole("button", { name: /^Tables/ }));
    expect(source("Metrics")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^All/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search name or kind" }), "prom");
    expect(source("Sales DB")).toBeNull();
    expect(within(table).getByRole("link", { name: "Metrics" })).toBeTruthy();
    expect(screen.getByText("1 of 2 sources")).toBeTruthy();
  });

  it("shows who has access in the side panel and opens the access dialog from it", async () => {
    const { server, user } = open("/data-sources");
    fakeAdmin(server).grants.push({
      id: "g-pg",
      subjectType: "team",
      subjectId: "t1",
      subjectName: "Analysts",
      resourceType: "datasource",
      resourceId: PG_ID,
      level: "query",
      createdAt: 0,
    });
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: /Sales DB/ });
    await user.click(within(row).getByRole("button", { name: "Details of “Sales DB”" }));
    const panel = await screen.findByRole("complementary", { name: "Sales DB" });
    expect(within(panel).getByRole("link", { name: "Edit" })).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Open in Explore" })).toBeTruthy();
    await user.click(within(panel).getByRole("tab", { name: "Access" }));
    const grants = await within(panel).findByRole("list", { name: "Granted access" });
    expect(within(grants).getByText("Analysts")).toBeTruthy();
    expect(within(grants).getByText("Can query")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Manage access…" }));
    expect(await screen.findByRole("dialog", { name: "Access to “Sales DB”" })).toBeTruthy();
  });

  it("loads every page while searching a list that is not fully loaded", async () => {
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
    await screen.findByRole("table");
    // Only the first page is loaded: the total says there may be more.
    expect(screen.getByText("50 of 50+ sources")).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "Search name or kind" }), "Source 5");
    expect(await screen.findByRole("link", { name: "Source 59" })).toBeTruthy();
    expect(lastCall(server, "GET", "/datasources?")?.path).toContain("cursor=50");
    expect(screen.getByText("10 of 62 sources")).toBeTruthy();
  });

  it("shows a refused test as no access, not as an unreachable source", async () => {
    const { server, user } = open("/data-sources");
    const table = await screen.findByRole("table");
    server.failNext(`/api/orgs/o1/datasources/${PG_ID}/health`, 403, "forbidden", "POST");
    await user.click(screen.getByRole("button", { name: "Test connection of “Sales DB”" }));
    const row = within(table).getByRole("row", { name: /Sales DB/ });
    expect(await within(row).findByText("No access")).toBeTruthy();
    // One live region for the page tells the outcome.
    expect(screen.getByText("Sales DB: No access")).toBeTruthy();
  });

  it("forgets a test result once the source is saved again", async () => {
    const { server, user } = open("/data-sources");
    server.areas.datasources.health[PG_ID] = { ok: true, message: "", latencyMs: 12 };
    const table = await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: "Test connection of “Sales DB”" }));
    const row = () => within(screen.getByRole("table")).getByRole("row", { name: /Sales DB/ });
    expect(await within(row()).findByText("Connected")).toBeTruthy();
    await user.click(within(table).getByRole("link", { name: "Sales DB" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.type(name, " 2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Data sources" }));
    await screen.findByRole("table");
    await waitFor(() =>
      expect(
        within(
          within(screen.getByRole("table")).getByRole("row", { name: /Sales DB 2/ }),
        ).getByText("Not tested"),
      ).toBeTruthy(),
    );
  });

  it("says so when the grants cannot be read", async () => {
    const { server, user } = open("/data-sources");
    fakeAdmin(server).managesResources = false;
    const table = await screen.findByRole("table");
    await user.click(within(table).getByRole("button", { name: "Details of “Sales DB”" }));
    const panel = await screen.findByRole("complementary", { name: "Sales DB" });
    await user.click(within(panel).getByRole("tab", { name: "Access" }));
    expect(
      await within(panel).findByText(
        "You cannot see who has access to this. Ask someone who manages its access.",
      ),
    ).toBeTruthy();
    // Home and End move between the tabs.
    await user.keyboard("{Home}");
    expect(within(panel).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await user.keyboard("{End}");
    expect(within(panel).getByRole("tab", { name: "Access" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("opens the side panel from a row click and moves focus to it", async () => {
    const { user } = open("/data-sources");
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: /Metrics/ });
    await user.click(within(row).getAllByRole("cell")[2] as HTMLElement);
    await screen.findByRole("complementary", { name: "Metrics" });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Metrics"));
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("closes the side panel with Escape and returns focus to the row", async () => {
    const { user } = open("/data-sources");
    const table = await screen.findByRole("table");
    const details = within(table).getByRole("button", { name: "Details of “Sales DB”" });
    await user.click(details);
    const panel = await screen.findByRole("complementary", { name: "Sales DB" });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel.isConnected).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(details));
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
  it("names each kind card by the product and describes it with its summary", async () => {
    open("/data-sources/new");
    const card = await screen.findByRole("link", { name: "PostgreSQL" });
    const description = document.getElementById(card.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Relational database, TimescaleDB included.");
    expect(card.querySelector(".kind-logo")?.getAttribute("data-logo")).toBe("postgresql");
  });

  it("starts from the kind's defaults and sends them, with secrets only in secrets", async () => {
    const { server, user, location } = open("/data-sources/new");
    await pickKind(user, "PostgreSQL");
    expect(screen.getByText(/pg_read_all_data/)).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Port (optional)" })).toHaveProperty(
      "value",
      "5432",
    );
    await openSection(user, "TLS");
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
    await openSection(user, "TLS");
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
    await openSection(user, "Limits");
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

  it("groups the kinds, finds them by search and shows the steps", async () => {
    const { user } = open("/data-sources/new");
    const tables = await screen.findByRole("list", { name: "Tables (SQL)" });
    expect(within(tables).getByRole("link", { name: "PostgreSQL" })).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(within(steps).getByText("Kind").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );
    await user.type(screen.getByRole("searchbox", { name: /Search, such as/ }), "graph");
    expect(screen.queryByRole("list", { name: "Tables (SQL)" })).toBeNull();
    expect(screen.getByRole("link", { name: "Neo4j" })).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Neo4j" }));
    await screen.findByRole("heading", { name: "Connect Neo4j" });
    expect(screen.getByRole("link", { name: "Neo4j" }).getAttribute("aria-current")).toBe("page");
    expect(within(steps).getByText("Connection").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );
    expect(within(steps).getByText("(done)")).toBeTruthy();
    // Neo4j has no connection string here: only the fields.
    expect(screen.queryByRole("button", { name: "Connection string" })).toBeNull();
    expect(screen.getByText("Not tested yet")).toBeTruthy();
  });

  it("fills the fields from a pasted connection string, the password as a secret", async () => {
    const { server, user } = open("/data-sources/new?kind=postgres");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Shop");
    // Without a host there is no string to show yet.
    expect(screen.getByText("Enter a host to see the connection as a string.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Connection string" }));
    const text = screen.getByRole("textbox", { name: "Connection string" });
    await user.clear(text);
    await user.click(text);
    // An unescaped @ in the password: the login ends at the last @.
    await user.paste("postgres://kalzit:se@cret@db.intern:6543/shop?sslmode=require");
    // The password left the box: only the mask stays visible.
    expect((text as HTMLInputElement).value).toBe(
      "postgres://kalzit:••••••••@db.intern:6543/shop?sslmode=require",
    );
    await user.click(screen.getByRole("button", { name: "Fields" }));
    expect(screen.getByRole("textbox", { name: "Host" })).toHaveProperty("value", "db.intern");
    expect(
      screen.getByText(/postgres:\/\/kalzit:•+@db\.intern:6543\/shop\?sslmode=require/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() =>
      expect(lastCall(server, "POST", "/datasources")?.body).toEqual({
        name: "Shop",
        kind: "postgres",
        settings: {
          host: "db.intern",
          port: 6543,
          database: "shop",
          user: "kalzit",
          sslMode: "require",
        },
        secrets: { password: "se@cret" },
      }),
    );
  });

  it("takes back a pasted password when the string no longer has one", async () => {
    const { server, user } = open("/data-sources/new?kind=postgres");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Shop");
    await user.click(screen.getByRole("button", { name: "Connection string" }));
    const text = screen.getByRole("textbox", { name: "Connection string" });
    await user.clear(text);
    await user.click(text);
    await user.paste("postgres://kalzit:secret@db.intern/shop");
    await user.clear(text);
    await user.click(text);
    await user.paste("postgres://kalzit@db.intern/shop");
    expect(screen.getByLabelText("Password (optional)")).toHaveProperty("value", "");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() =>
      expect(lastCall(server, "POST", "/datasources")?.body).toMatchObject({ secrets: {} }),
    );
  });

  it("keeps the TLS mode when a pasted string leaves it out", async () => {
    const { user } = open("/data-sources/new?kind=postgres");
    await screen.findByRole("textbox", { name: "Name" });
    await openSection(user, "TLS");
    await user.selectOptions(screen.getByRole("combobox", { name: "TLS mode" }), "verify-full");
    await user.click(screen.getByRole("button", { name: "Connection string" }));
    const text = screen.getByRole("textbox", { name: "Connection string" });
    await user.clear(text);
    await user.click(text);
    await user.paste("postgres://kalzit@db.intern/shop");
    expect(screen.getByRole("combobox", { name: "TLS mode" })).toHaveProperty(
      "value",
      "verify-full",
    );
  });

  it("does not save while the connection string cannot be read", async () => {
    const { server, user } = open("/data-sources/new?kind=postgres");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Shop");
    await user.click(screen.getByRole("button", { name: "Connection string" }));
    const text = screen.getByRole("textbox", { name: "Connection string" });
    await user.clear(text);
    await user.click(text);
    await user.paste("postgres://kalzit@db.intern/shop?sslmode=sometimes");
    expect(screen.getByText(/The value of sslmode is not one this kind accepts/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    await waitFor(() => expect(document.activeElement).toBe(text));
    expect(text.getAttribute("aria-invalid")).toBe("true");
    expect(lastCall(server, "POST", "/datasources")).toBeUndefined();
  });

  it("saves and tests a new source and shows the result on its page", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    await fill(
      user,
      screen.getByRole("textbox", { name: "Absolute path of the file" }),
      "/data/a.db",
    );
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(location().pathname).toBe("/data-sources/ds-new-1"));
    expect(lastCall(server, "POST", "ds-new-1/health")).toBeTruthy();
    expect(await screen.findByText(/Connected in \d+ ms/)).toBeTruthy();
  });

  it("says when a new source was saved but its test could not run", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    server.failNext("/api/orgs/o1/datasources/ds-new-1/health", 403, "forbidden", "POST");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    await fill(
      user,
      screen.getByRole("textbox", { name: "Absolute path of the file" }),
      "/data/a.db",
    );
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    await waitFor(() => expect(location().pathname).toBe("/data-sources/ds-new-1"));
    expect(
      await screen.findByText("The data source was added, but the test could not run."),
    ).toBeTruthy();
    expect(screen.queryByText("Not tested yet")).toBeNull();
  });

  it("stays on the form when saving fails", async () => {
    const { server, user, location } = open("/data-sources/new?kind=sqlite");
    server.failNext("/api/orgs/o1/datasources", 503, "busy", "POST");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Local");
    await fill(
      user,
      screen.getByRole("textbox", { name: "Absolute path of the file" }),
      "/data/a.db",
    );
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
    expect(location().pathname).toBe("/data-sources/new");
    expect(lastCall(server, "POST", "/health")).toBeUndefined();
  });

  it("opens a closed section that holds a field with an error", async () => {
    const { user } = open("/data-sources/new?kind=postgres");
    await fill(user, await screen.findByRole("textbox", { name: "Name" }), "Shop");
    await user.click(screen.getByRole("button", { name: /^Connection(?! string)/ }));
    expect(screen.queryByRole("textbox", { name: "Host" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    const host = await screen.findByRole("textbox", { name: "Host" });
    expect(host.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(host));
  });

  it("shows a setting this UI does not know under Behavior, summed up when changed", async () => {
    const sqlite = FAKE_KINDS.find((kind) => kind.kind === "sqlite");
    sqlite?.settings.push({
      name: "journalMode",
      labelKey: "datasources.settings.journalMode",
      type: "string",
      required: false,
      secret: false,
      target: false,
      default: "wal",
    });
    try {
      const { user } = open("/data-sources/new?kind=sqlite");
      await screen.findByRole("textbox", { name: "Name" });
      // At its default the closed section shows no summary.
      const behavior = screen.getByRole("button", { name: "Behavior" });
      await user.click(behavior);
      const field = screen.getByRole("textbox", { name: "journalMode (optional)" });
      await user.clear(field);
      await user.type(field, "delete");
      await user.click(behavior);
      expect(screen.getByRole("button", { name: "Behavior delete" })).toBeTruthy();
    } finally {
      sqlite?.settings.pop();
    }
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
    await fill(user, port, "70000");
    await user.click(screen.getByRole("button", { name: "Add data source" }));
    expect(screen.getByText("Enter a port between 1 and 65535.")).toBeTruthy();

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
    expect(lastCall(server, "PATCH", "ds-lean")?.body).toEqual({
      name: "Shop",
      secrets: {},
      expectedUpdatedAt: 1,
    });
    const stored = server.areas.datasources.datasources.find((d) => d.id === "ds-lean");
    expect(stored?.settings).toEqual({ host: "db.internal", database: "shop", user: "reader" });
    expect(stored?.secrets).toEqual({ password: "s3cret" });
  });

  it("asks for stored secrets again when the target changes, as the contract requires", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    expect(await screen.findByText("Set")).toBeTruthy();
    // The stored TLS mode is shown, not the default; the closed section sums it up.
    expect(screen.getByRole("button", { name: /^TLS verify-full/ })).toBeTruthy();
    await openSection(user, "TLS");
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
    const path = await screen.findByRole("textbox", { name: "Absolute path of the file" });
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
        expectedUpdatedAt: expect.any(Number),
      }),
    );
    expect(server.areas.datasources.datasources[0]?.secrets).toEqual({});
  });

  it("shows a change saved by someone else in the meantime instead of overwriting it", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    const name = await screen.findByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Mine");
    // Someone else renames the source after this page loaded.
    const stored = server.areas.datasources.datasources.find((d) => d.id === PG_ID);
    if (stored === undefined) throw new Error("no source");
    stored.name = "Theirs";
    stored.updatedAt += 1;
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(dialog.textContent).toMatch(/Someone else saved “Theirs”/);
    expect(stored.name).toBe("Theirs");
    // Loading the saved version shows it in the form.
    await user.click(screen.getByRole("button", { name: "Load saved version" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByDisplayValue("Theirs")).toBeTruthy();

    // A second stale save, this time put through over the stored source.
    const field = screen.getByRole("textbox", { name: "Name" });
    await user.clear(field);
    await user.type(field, "Mine");
    stored.name = "Theirs again";
    stored.updatedAt += 1;
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(await screen.findByRole("button", { name: "Save mine over it" }));
    await screen.findByText("Saved.");
    expect(stored.name).toBe("Mine");
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({ name: "Mine" });
  });

  it("does not delete a source someone else changed since the page loaded", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const stored = server.areas.datasources.datasources.find((d) => d.id === PG_ID);
    if (stored === undefined) throw new Error("no source");
    stored.updatedAt += 1;
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(stored.deletedAt).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Delete anyway" }));
    await waitFor(() => expect(stored.deletedAt).toBeDefined());
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
    await openSection(user, "Limits");
    await user.type(screen.getByRole("textbox", { name: "Row limit (optional)" }), "1000");
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("The connection failed")).toBeTruthy();
    expect(screen.getByText(/does not allow connections to this address/)).toBeTruthy();
    expect(lastCall(server, "PATCH", PG_ID)?.body).toMatchObject({
      settings: { maxRows: 1000, host: "db.internal" },
      secrets: {},
    });
  });

  it("still tests after saving over a change made in the meantime with Save and test", async () => {
    const { server, user } = open(`/data-sources/${PG_ID}`);
    await screen.findByRole("textbox", { name: "Name" });
    await openSection(user, "Limits");
    await user.type(await screen.findByRole("textbox", { name: "Row limit (optional)" }), "1000");
    const stored = server.areas.datasources.datasources.find((d) => d.id === PG_ID);
    if (stored === undefined) throw new Error("no source");
    stored.updatedAt += 1;
    const tests = () =>
      server.calls.filter((c) => c.method === "POST" && c.path.endsWith(`/${PG_ID}/health`)).length;
    await user.click(screen.getByRole("button", { name: "Save and test" }));
    await user.click(await screen.findByRole("button", { name: "Save mine over it" }));
    expect(await screen.findByText("Connected in 12 ms")).toBeTruthy();
    expect(tests()).toBe(1);
    expect(stored.settings.maxRows).toBe(1000);
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
