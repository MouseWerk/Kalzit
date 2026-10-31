import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App, createApp } from "../../app/app";
import { browserHistoryAt } from "../../test/browserHistory";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { emptyModel } from "./model";
import { addDashboard, addFolder } from "./test/fakeDashboards";

/**
 * The browser's or mouse's Back button against the router's own history (memory history with a
 * page before the dashboard), not a fake popstate event.
 */
let cleanup = () => {};
afterEach(() => cleanup());

function open() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addFolder(server.areas.dashboards, "f-ops", "Operations");
  addDashboard(
    server.areas.dashboards,
    "d-main",
    {
      ...emptyModel("Main"),
      panels: [
        {
          id: "p1",
          type: "table",
          title: "Orders",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    },
    { folderId: "f-ops" },
  );
  const { history, destroy } = browserHistoryAt("/dashboards", "/dashboards/d-main");
  cleanup = destroy;
  const app = createApp({ history, retry: false });
  render(<App app={app} />);
  return {
    app,
    server,
    user: userEvent.setup(),
    back: () => act(() => window.history.back()),
  };
}

async function makeDirty(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const panel = await screen.findByRole("article", { name: "Orders" });
  await user.click(within(panel).getByRole("button", { name: "Panel menu of “Orders”" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove “Orders”" }));
}

describe("the Back button on a dashboard", () => {
  it("asks about unsaved changes, and Leave then leaves", async () => {
    const { app, user, back } = open();
    await makeDirty(user);
    back();
    const ask = await screen.findByRole("dialog", { name: "Leave without saving?" });
    expect(app.router.state.location.pathname).toBe("/dashboards/d-main");
    await user.click(within(ask).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/dashboards"));
  });

  it("closes an open dialog first, and only the next press asks about leaving", async () => {
    const { app, user, back } = open();
    await makeDirty(user);
    await user.click(screen.getByRole("button", { name: "Save…" }));
    await screen.findByRole("dialog", { name: "Save dashboard" });
    back();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Save dashboard" })).toBeNull(),
    );
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
    expect(app.router.state.location.pathname).toBe("/dashboards/d-main");
    // The held press puts the browser back on the page (asynchronously); then press again.
    await waitFor(() => expect(window.location.pathname).toBe("/dashboards/d-main"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    back();
    expect(await screen.findByRole("dialog", { name: "Leave without saving?" })).toBeTruthy();
  });
});

describe("signing out of a dashboard with unsaved changes", () => {
  async function signOut(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /Account/ }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
  }

  it("asks first; Cancel stays on the dashboard with the edits", async () => {
    const { app, server, user } = open();
    await makeDirty(user);
    await signOut(user);
    const ask = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull(),
    );
    expect(app.router.state.location.pathname).toBe("/dashboards/d-main");
    // Still in edit mode, the removed panel still gone, and the session untouched.
    expect(screen.getByRole("button", { name: "Save…" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Orders" })).toBeNull();
    expect(server.calls.some((call) => call.path.startsWith("/api/auth/logout"))).toBe(false);
  });

  it("signs out after Leave, with nothing asked of the ended session", async () => {
    const { app, server, user } = open();
    await makeDirty(user);
    await signOut(user);
    const ask = await screen.findByRole("dialog", { name: "Leave without saving?" });
    await user.click(within(ask).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe("/login");
    const logoutAt = server.calls.findIndex((call) => call.path.startsWith("/api/auth/logout"));
    expect(logoutAt).toBeGreaterThanOrEqual(0);
    const after = server.calls
      .slice(logoutAt + 1)
      .map((call) => call.path)
      .filter(
        (path) =>
          !["/api/me", "/api/setup", "/api/branding"].includes(path) &&
          !path.startsWith("/api/auth/"),
      );
    expect(after).toEqual([]);
  });

  it("signs out without asking when nothing is unsaved", async () => {
    const { user } = open();
    await screen.findByRole("button", { name: "Edit" });
    await signOut(user);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" })).toBeNull();
  });
});
