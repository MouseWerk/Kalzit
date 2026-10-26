import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryOutcome } from "../../api/generated/shapes";
import { installFakeLive } from "../../test/fakeLive";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { addDashboard } from "./test/fakeDashboards";

/**
 * Live dashboards through the whole app, with the live socket played by the test: the toggle in
 * the refresh menu, the subscriptions of the panels, pushed results in the panels, the quiet
 * status per panel, pause and resume.
 */

let live: ReturnType<typeof installFakeLive>;

afterEach(() => {
  live.reset();
});

const orders: PanelModel = {
  id: "p1",
  type: "table",
  title: "Orders",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
};

function setup(extra: Partial<DashboardModel> = {}) {
  live = installFakeLive();
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "viewer" }] },
  });
  addDashboard(server.areas.dashboards, "d-main", {
    ...emptyModel("Main"),
    panels: [orders],
    ...extra,
  });
  return { server, ...renderApp("/dashboards/d-main") };
}

function names(values: string[]): Record<string, QueryOutcome> {
  return {
    A: {
      result: {
        shape: "frame",
        frame: { fields: [{ name: "customer", type: "string", values }] },
      },
    },
  };
}

async function turnLiveOn(user: ReturnType<typeof setup>["user"]) {
  await user.click(await screen.findByRole("button", { name: /^Refresh automatically/ }));
  const menu = screen.getByRole("menu", { name: /^Refresh automatically/ });
  await user.click(within(menu).getByRole("menuitemradio", { name: "Live" }));
}

describe("live dashboards", () => {
  it("subscribes the panels when live is turned on and draws the results pushed", async () => {
    const { user } = setup({ refreshSeconds: 15 });
    await screen.findByRole("heading", { level: 1, name: "Main" });
    expect(live.sockets).toHaveLength(0);
    await turnLiveOn(user);
    // The toolbar says live is on, in place of the interval.
    const button = screen.getByRole("button", { name: "Refresh automatically: live" });
    expect(button.textContent).toContain("Live");
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    const socket = live.last();
    expect(socket.path).toBe("/api/orgs/o1/live");
    act(() => socket.open());
    const [subscribe] = socket.subscribes();
    expect(subscribe).toMatchObject({
      type: "subscribe",
      panel: { dashboardId: "d-main", panelId: "p1" },
      // The default range ends now: each run looks back six hours from its own moment.
      lastMs: 6 * 3_600_000,
      refreshMs: 15_000,
      variables: {},
    });
    expect(subscribe?.timeRange).toBeUndefined();
    const id = String(subscribe?.id);
    act(() => {
      socket.receive({ type: "subscribed", id, feed: "f1" });
      socket.receive({ type: "status", feed: "f1", mode: "changes", refreshMs: 15_000 });
      socket.receive({ type: "result", feed: "f1", at: Date.now(), results: names(["Lovelace"]) });
    });
    const panel = screen.getByRole("article", { name: "Orders" });
    expect(await within(panel).findByText("Lovelace")).toBeTruthy();
    const status = within(panel).getByText("Live", { selector: ".panel-card__live" });
    expect(status.getAttribute("title")).toBe("Updates as soon as the data changes.");
    act(() =>
      socket.receive({ type: "result", feed: "f1", at: Date.now(), results: names(["Hopper"]) }),
    );
    expect(await within(panel).findByText("Hopper")).toBeTruthy();
    expect(within(panel).queryByText("Lovelace")).toBeNull();
  });

  it("shows why a panel polls, and why it stopped, as quiet text with the reason", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await turnLiveOn(user);
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    const socket = live.last();
    act(() => socket.open());
    const id = String(socket.subscribes()[0]?.id);
    act(() => {
      socket.receive({ type: "subscribed", id, feed: "f1" });
      socket.receive({
        type: "status",
        feed: "f1",
        mode: "poll",
        refreshMs: 30_000,
        reason: "live.streams_limit",
      });
    });
    const panel = screen.getByRole("article", { name: "Orders" });
    const status = await within(panel).findByText("Live, every 30s", {
      selector: ".panel-card__live",
    });
    expect(status.getAttribute("title")).toBe(
      "The queries run again every 30s. This source already reports changes for as many queries as it allows, so this one runs again at a fixed interval.",
    );
    act(() =>
      socket.receive({
        type: "error",
        id,
        error: { code: "busy", message: "full", reason: "live.memory_limit" },
      }),
    );
    const stopped = await within(panel).findByText("Live stopped", {
      selector: ".panel-card__live",
    });
    expect(stopped.getAttribute("title")).toMatch(/^Live results here would take more memory/);
  });

  it("pauses and resumes from the refresh menu, and turning live off ends the subscriptions", async () => {
    const { user } = setup();
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await turnLiveOn(user);
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    const socket = live.last();
    act(() => socket.open());
    await waitFor(() => expect(socket.subscribes()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Refresh automatically: live" }));
    await user.click(screen.getByRole("menuitem", { name: "Pause live updates" }));
    expect(socket.sent.at(-1)).toMatchObject({ type: "unsubscribe" });
    const paused = screen.getByRole("button", { name: "Refresh automatically: live, paused" });
    expect(paused.textContent).toContain("Live paused");

    await user.click(paused);
    await user.click(screen.getByRole("menuitem", { name: "Resume live updates" }));
    await waitFor(() => expect(socket.subscribes()).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Refresh automatically: live" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Auto refresh off" }));
    expect(socket.sent.at(-1)).toMatchObject({ type: "unsubscribe" });
    expect(screen.getByRole("button", { name: "Refresh automatically" })).toBeTruthy();
    expect(document.querySelector(".panel-card__live")).toBeNull();
  });

  it("subscribes a fixed range as it is, without moving it", async () => {
    const { user } = setup({
      timeRange: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" },
    });
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await turnLiveOn(user);
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    act(() => live.last().open());
    expect(live.last().subscribes()[0]).toMatchObject({
      timeRange: {
        from: Date.parse("2026-01-01T00:00:00Z"),
        to: Date.parse("2026-01-02T00:00:00Z"),
      },
    });
    expect(live.last().subscribes()[0]?.lastMs).toBeUndefined();
  });
});
