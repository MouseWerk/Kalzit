import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getTimeSettings } from "../../lib/timeSettings";
import { SHORTCUT_AREAS } from "../../shell/ShortcutsHelp";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { diffModels } from "./diff";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { addDashboard, latest } from "./test/fakeDashboards";

/**
 * The dashboard header and the time picker through the whole app against the fake server: the
 * time controls and their shortcuts, the refresh menu, quick range search, recent ranges, the
 * calendar, copy and paste, and the dashboard's own time options.
 */

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

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

function setup(role: string, extra: Partial<DashboardModel> = {}) {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  const stored = addDashboard(server.areas.dashboards, "d-main", {
    ...emptyModel("Main"),
    panels: [orders],
    ...extra,
  });
  return { server, stored };
}

/** The range the last panel query ran with. */
function lastRange(server: ReturnType<typeof setup>["server"]) {
  const call = server.calls.filter((c) => c.path.includes("/panels/")).at(-1);
  return (call?.body as { timeRange?: { from: number; to: number } } | undefined)?.timeRange;
}

describe("time controls", () => {
  it("moves and zooms the range with its buttons and with t and the arrow keys", async () => {
    setup("viewer");
    const { user, location } = renderApp("/dashboards/d-main");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    const controls = screen.getByRole("group", { name: "Time range" });
    await user.click(within(controls).getByRole("button", { name: "Move the time range back" }));
    expect(location().search).toMatchObject({ from: "now-12h", to: "now-6h" });
    await user.keyboard("t{ArrowRight}");
    expect(location().search).toMatchObject({ from: "now-6h", to: "now" });
    await user.keyboard("tz");
    expect(location().search).toMatchObject({ from: "now-12h", to: "now" });
    // "t" alone, or another key after it, does nothing.
    await user.keyboard("t");
    await user.keyboard("x{ArrowLeft}");
    expect(location().search).toMatchObject({ from: "now-12h", to: "now" });
    await user.click(
      within(controls).getByRole("button", { name: "Zoom out: twice the time range" }),
    );
    expect(location().search).toMatchObject({ from: "now-24h", to: "now" });
    // Every control names itself and its shortcut.
    expect(
      within(controls)
        .getByRole("button", { name: "Move the time range forward" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("t ArrowRight");
  });

  it("copies the range with t c and pastes it with t v", async () => {
    setup("viewer");
    const { user, location } = renderApp("/dashboards/d-main");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await user.keyboard("tc");
    expect(await screen.findByText("Time range copied.")).toBeTruthy();
    await user.keyboard("t{ArrowLeft}");
    expect(location().search).toMatchObject({ from: "now-12h", to: "now-6h" });
    await user.keyboard("tv");
    await waitFor(() => expect(location().search).toMatchObject({ from: "now-6h", to: "now" }));
    await navigator.clipboard.writeText("not a range");
    await user.keyboard("tv");
    expect(await screen.findByText(/The clipboard holds no time range/)).toBeTruthy();
  });

  it("says so when the browser offers no clipboard (plain HTTP)", async () => {
    setup("viewer");
    const { user, location } = renderApp("/dashboards/d-main");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await user.keyboard("tc");
      expect(await screen.findByText(/The time range could not be copied/)).toBeTruthy();
      await user.keyboard("tv");
      expect(await screen.findByText(/Nothing could be pasted/)).toBeTruthy();
      expect(location().search).not.toHaveProperty("from");
    } finally {
      if (clipboard !== undefined) {
        Object.defineProperty(navigator, "clipboard", clipboard);
      }
    }
  });

  it("lists the time shortcuts in the shortcuts help", () => {
    const area = SHORTCUT_AREAS.find((a) => a.title === "shell.shortcuts.area.time");
    expect(area?.shortcuts.map((s) => s.keys[0]?.join(" "))).toEqual([
      "t ←",
      "t →",
      "t z",
      "t c",
      "t v",
    ]);
  });
});

describe("time picker", () => {
  it("searches the quick ranges and takes the first match with Enter", async () => {
    setup("viewer", { fiscalYearStartMonth: 4 });
    const { user, location } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /^Time range: Last 6 hours/ }));
    const picker = screen.getByRole("dialog", { name: "Time range" });
    const search = within(picker).getByRole("searchbox", { name: "Search quick ranges" });
    expect(document.activeElement).toBe(search);
    // The current range is marked by tint and weight (aria-pressed), the fiscal ones are offered.
    expect(
      within(picker).getByRole("button", { name: "Last 6 hours" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(picker).getByRole("button", { name: "Previous fiscal year" })).toBeTruthy();
    await user.type(search, "yester");
    const list = within(picker)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(list).toEqual(["Yesterday", "Day before yesterday"]);
    await user.type(search, "{Enter}");
    expect(location().search).toMatchObject({ from: "now-1d/d", to: "now-1d/d" });
    expect(screen.queryByRole("dialog", { name: "Time range" })).toBeNull();
    // Focus is back on the button.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Time range: Yesterday/ }),
    );
  });

  it("offers no fiscal ranges without a fiscal year, and closes with Escape", async () => {
    setup("viewer");
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /^Time range: Last 6 hours/ }));
    const picker = screen.getByRole("dialog", { name: "Time range" });
    expect(within(picker).queryByRole("button", { name: "Previous fiscal year" })).toBeNull();
    await user.type(within(picker).getByRole("searchbox"), "nothing like this");
    expect(within(picker).getByText("No quick range matches.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Time range" })).toBeNull();
  });

  it("remembers ranges this account applied and picks days on the calendar", async () => {
    setup("viewer");
    const { user, location } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /^Time range: Last 6 hours/ }));
    let picker = screen.getByRole("dialog", { name: "Time range" });
    expect(within(picker).queryByRole("heading", { name: "Recently used" })).toBeNull();
    await user.click(within(picker).getByRole("button", { name: "Pick the start day" }));
    const grid = within(picker).getByRole("table", { name: /Pick the start day/ });
    const days = within(grid).getAllByRole("button");
    await user.click(days[9] as HTMLElement);
    const from = within(picker).getByRole("textbox", { name: "From" }) as HTMLInputElement;
    expect(from.value).toMatch(/^\d{4}-\d{2}-10 00:00:00$/);
    // The calendar now picks the end.
    const endGrid = within(picker).getByRole("table", { name: /Pick the end day/ });
    await user.click(within(endGrid).getAllByRole("button")[11] as HTMLElement);
    const to = within(picker).getByRole("textbox", { name: "To" }) as HTMLInputElement;
    expect(to.value).toMatch(/^\d{4}-\d{2}-12 23:59:59$/);
    await user.click(within(picker).getByRole("button", { name: "Apply time range" }));
    const applied = location().search as { from: string; to: string };
    expect(applied.from).toMatch(/Z$/);

    await user.click(screen.getByRole("button", { name: /^Time range: / }));
    picker = screen.getByRole("dialog", { name: "Time range" });
    const recent = within(picker).getByRole("list", { name: "Recently used" });
    expect(within(recent).getAllByRole("button")).toHaveLength(1);
    await user.click(within(picker).getByRole("button", { name: "Last 15 minutes" }));
    // Quick ranges are not kept as recent: they are always in the list.
    await user.click(screen.getByRole("button", { name: /^Time range: Last 15 minutes/ }));
    picker = screen.getByRole("dialog", { name: "Time range" });
    expect(
      within(within(picker).getByRole("list", { name: "Recently used" })).getAllByRole("button"),
    ).toHaveLength(1);
  });

  it("moves through the calendar with the keyboard", async () => {
    setup("viewer");
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: /^Time range: Last 6 hours/ }));
    const picker = screen.getByRole("dialog", { name: "Time range" });
    await user.click(within(picker).getByRole("button", { name: "Pick the start day" }));
    const grid = within(picker).getByRole("table", { name: /Pick the start day/ });
    const tabbable = grid.querySelectorAll('button[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    (tabbable[0] as HTMLElement).focus();
    const start = document.activeElement?.getAttribute("aria-label");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe(start);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(start);
  });
});

describe("refresh", () => {
  it("offers the dashboard's own intervals and shows the one running", async () => {
    setup("viewer", { refreshIntervals: [15, 120] });
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Refresh automatically" }));
    const menu = screen.getByRole("menu", { name: "Refresh automatically" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Auto refresh off",
      "Every 15 seconds",
      "Every 2 minutes",
    ]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    await user.click(items[1] as HTMLElement);
    const button = screen.getByRole("button", {
      name: "Refresh automatically: Every 15 seconds",
    });
    expect(button.textContent).toContain("15s");
    expect(document.activeElement).toBe(button);
  });
});

describe("the dashboard's time options", () => {
  it("resolves the range in the dashboard's zone and with its now delay, only while it is open", async () => {
    const { server } = setup("viewer", { timeZone: "Asia/Tokyo", nowDelay: "5m" });
    const { user } = renderApp("/dashboards/d-main");
    await screen.findByRole("heading", { level: 1, name: "Main" });
    await waitFor(() => expect(getTimeSettings().timeZone).toBe("Asia/Tokyo"));
    const before = Date.now();
    await waitFor(() => expect(lastRange(server)).toBeDefined());
    const range = lastRange(server) ?? { from: 0, to: 0 };
    expect(range.to).toBeLessThanOrEqual(before - 5 * 60_000 + 1000);
    expect(range.to - range.from).toBe(6 * 3_600_000);
    await user.click(screen.getByRole("button", { name: /^Time range: Last 6 hours/ }));
    expect(screen.getByText(/^Times in Asia\/Tokyo.*as this dashboard sets$/)).toBeTruthy();
    await user.keyboard("{Escape}");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await waitFor(() => expect(getTimeSettings().timeZone).toBeNull());
  });

  it("sets them in the settings, checks them, and saves them with the dashboard", async () => {
    const { stored } = setup("editor");
    const { user } = renderApp("/dashboards/d-main");
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Settings…" }));
    const dialog = screen.getByRole("dialog", { name: "Dashboard settings" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Time zone" }), "UTC");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "First day of the week" }),
      "sunday",
    );
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Fiscal year starts in" }),
      "7",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Now delay" }), "1m");
    const intervals = within(dialog).getByRole("textbox", { name: "Refresh intervals" });
    await user.type(intervals, "1m, 2s");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Shared cursor" }),
      "tooltip",
    );
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(within(dialog).getByText("2s is not an interval from 5s to 1d.")).toBeTruthy();
    await user.clear(intervals);
    await user.type(intervals, "5m, 30s, 5m");
    await user.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog", { name: "Dashboard settings" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save…" }));
    const save = screen.getByRole("dialog", { name: "Save dashboard" });
    await user.click(within(save).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(latest(stored as never).version).toBe(2));
    expect(latest(stored as never).model).toMatchObject({
      timeZone: "UTC",
      weekStart: "sunday",
      fiscalYearStartMonth: 7,
      nowDelay: "1m",
      refreshIntervals: [30, 300],
      sharedCursor: "tooltip",
    });
  });

  it("names a change of the time options in the version comparison", () => {
    const before = emptyModel("Main");
    expect(diffModels(before, { ...before, sharedCursor: "crosshair" })).toEqual([
      { kind: "timeOptions" },
    ]);
    expect(diffModels(before, { ...before, refreshIntervals: [30] })).toEqual([
      { kind: "refresh" },
    ]);
  });
});

describe("the rail", () => {
  it("offers export and the outline, and is always shown", async () => {
    setup("viewer");
    const { user } = renderApp("/dashboards/d-main");
    const rail = await screen.findByRole("complementary", { name: "Dashboard tools" });
    expect(within(rail).getByRole("button", { name: "Export as JSON" })).toBeTruthy();
    expect(within(rail).queryByRole("button", { name: "Add" })).toBeNull();
    const outlineButton = within(rail).getByRole("button", { name: "Outline" });
    await user.click(outlineButton);
    expect(outlineButton.getAttribute("aria-expanded")).toBe("true");
    const outline = within(rail).getByRole("navigation", { name: "Outline" });
    // Each entry names the panel, then its visualization and size.
    await user.click(within(outline).getByRole("button", { name: /^Orders/ }));
    await user.click(within(rail).getByRole("button", { name: "Info" }));
    const info = screen.getByRole("dialog", { name: "About this dashboard" });
    expect(within(info).getByText("Panels").nextElementSibling?.textContent).toBe("1");
    await user.keyboard("{Escape}");
    await user.click(within(rail).getByRole("button", { name: "Filters" }));
    expect(screen.queryByRole("region", { name: "Variables" })).toBeNull();
    // Nothing folds it away.
    expect(within(rail).queryByRole("button", { name: /tools/i })).toBeNull();
  });
});
