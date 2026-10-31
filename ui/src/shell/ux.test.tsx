import { defaultKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/Toaster";
import { emptyModel } from "../features/dashboards/model";
import { addDashboard, addFolder } from "../features/dashboards/test/fakeDashboards";
import { getLanguage, LANGUAGE_STORAGE_KEY } from "../i18n/i18n";
import { choiceFor, LOCAL_CHOICE_KEY, recordChoice } from "../lib/localChoice";
import { setTimeZone } from "../lib/timeSettings";
import { showToast, UNDO_TOAST_MS } from "../lib/toasts";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { getTheme } from "../theme/theme";
import { SEARCH_DELAY_MS } from "./CommandPalette";
import { fuzzyScore } from "./fuzzy";
import { SETUP_DISMISSED_KEY } from "./setupSteps";
import { SIDEBAR_STORAGE_KEY } from "./sidebarState";

/** Picks a language or theme from the top bar of the sign-in page. */
async function chooseBeforeSignIn(
  user: ReturnType<typeof renderApp>["user"],
  menu: RegExp,
  option: string,
) {
  await user.click(await screen.findByRole("button", { name: menu }));
  await user.click(screen.getByRole("menuitemradio", { name: option }));
}

function asRole(role: string) {
  return { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role }] };
}

function setup(role = "editor") {
  const server = installFakeServer({ signedIn: true, user: asRole(role) });
  const { dashboards } = server.areas;
  addFolder(dashboards, "f-ops", "Operations");
  addFolder(dashboards, "f-hr", "People", { restricted: true });
  addDashboard(dashboards, "d-sales", emptyModel("Sales overview"), { folderId: "f-ops" });
  addDashboard(dashboards, "d-people", emptyModel("Salaries"), { folderId: "f-hr" });
  addDashboard(dashboards, "d-stock", emptyModel("Stock"));
  return server;
}

async function openPalette(path = "/", role = "editor") {
  const server = setup(role);
  const rendered = renderApp(path);
  await screen.findByRole("navigation", { name: "Main navigation" });
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(dialog).getByRole("combobox", { name: "Search or run a command" });
  return { ...rendered, server, dialog, input };
}

const options = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("option")
    .map((option) => option.querySelector(".palette__label")?.textContent ?? "");

describe("fuzzy matching", () => {
  it("ranks whole, prefix, word start, substring and letters in order, as the server does", () => {
    const ranked = [
      fuzzyScore("ums", "Umsatz"),
      fuzzyScore("ums", "Monat Umsatz"),
      fuzzyScore("ums", "Kumsatz"),
      fuzzyScore("umz", "Umsatz"),
    ];
    // The same numbers as `better_matches_score_higher` in server/src/routes/home.rs.
    expect(ranked).toEqual([897, 794, 699, 122]);
    expect(fuzzyScore("umsatz", "UMSATZ")).toBe(1000);
    expect(fuzzyScore("über", "Übersicht")).toBe(895);
    expect(fuzzyScore("zu", "Umsatz")).toBeUndefined();
    expect(fuzzyScore("", "x")).toBe(0);
  });
});

describe("command palette", () => {
  it("opens with Ctrl+K as a combobox, lists actions and pages, and closes with Escape", async () => {
    const { dialog, input } = await openPalette();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = within(dialog).getByRole("listbox", { name: "Results" });
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(within(listbox).getByRole("group", { name: "Create" })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: "Navigation" })).toBeTruthy();
    expect(options(dialog)).toContain("New dashboard");
    expect(options(dialog)).toContain("Open Explore");
    // The first option is active, named by aria-activedescendant.
    const active = input.getAttribute("aria-activedescendant") ?? "";
    expect(document.getElementById(active)?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull(),
    );
  });

  it("groups the actions, offers every theme with the current one checked and a keycap for help", async () => {
    const { dialog } = await openPalette();
    const listbox = within(dialog).getByRole("listbox", { name: "Results" });
    for (const name of ["Appearance", "Language", "Help"]) {
      expect(within(listbox).getByRole("group", { name })).toBeTruthy();
    }
    expect(options(dialog)).toEqual(
      expect.arrayContaining([
        "Theme: System",
        "Theme: Light",
        "Theme: Dark",
        "Theme: High contrast",
      ]),
    );
    expect(within(dialog).getAllByText("current").length).toBeGreaterThanOrEqual(2);
    const help = within(dialog).getByRole("option", { name: /Keyboard shortcuts/ });
    expect(help.querySelector("kbd")?.textContent).toBe("?");
  });

  it("finds only what the user may open, moves with the arrow keys and opens with Enter", async () => {
    const { dialog, input, user, location, server } = await openPalette();
    await user.paste("sal");
    await waitFor(() => expect(options(dialog)).toContain("Sales overview"));
    // The restricted folder's dashboard does not exist for an editor.
    expect(options(dialog)).not.toContain("Salaries");
    expect(server.calls.some((call) => call.path.includes("/search?q=sal"))).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toMatch(/results/);

    const sales = within(dialog)
      .getAllByRole("option")
      .find((o) => o.textContent?.includes("Sales overview"));
    const target = sales as HTMLElement;
    while (input.getAttribute("aria-activedescendant") !== target.id) {
      await user.keyboard("{ArrowDown}");
    }
    expect(target.getAttribute("aria-selected")).toBe("true");
    expect(target.textContent).toContain("Operations");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-sales"));
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("asks the server once per pause in typing", async () => {
    const { input, server } = await openPalette();
    fireEvent.change(input, { target: { value: "s" } });
    fireEvent.change(input, { target: { value: "st" } });
    fireEvent.change(input, { target: { value: "sto" } });
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS * 3));
    const searches = server.areas.shell.searches;
    expect(searches.filter((q) => q.includes("q=s&") || q.endsWith("q=s"))).toHaveLength(0);
    expect(searches.some((q) => q.includes("q=sto"))).toBe(true);
  });

  it("offers no actions a viewer could not take, and never the restricted content", async () => {
    const { dialog, user } = await openPalette("/", "viewer");
    expect(options(dialog)).not.toContain("New dashboard");
    expect(options(dialog)).not.toContain("Add data source");
    expect(options(dialog)).not.toContain("Members");
    await user.paste("s");
    await waitFor(() => expect(options(dialog)).toContain("Stock"));
    expect(options(dialog)).not.toContain("Salaries");
  });

  it("switches the theme as a saved preference", async () => {
    const { dialog, user, server, app } = await openPalette();
    // The preferences have arrived, so the change is not raced by their first answer.
    await waitFor(() =>
      expect(app.queryClient.getQueryData(["preferences", TEST_USER.id])).toBeDefined(),
    );
    await user.paste("dark");
    // Once the pause in typing is over, the list is rebuilt as ranked results; pick from that.
    await waitFor(() => expect(options(dialog)).not.toContain("New dashboard"));
    const dark = await within(dialog).findByRole("option", { name: /Theme: Dark/ });
    await user.click(dark);
    await waitFor(() => expect(getTheme()).toBe("dark"));
    await waitFor(() => expect(server.state.preferences.theme).toBe("dark"));
  });
});

describe("search with /", () => {
  it("opens the palette, but not while typing", async () => {
    setup();
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(document.body, { key: "/" });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    // In the palette's field, "/" is a letter to search for.
    await user.keyboard("/");
    expect((within(dialog).getByRole("combobox") as HTMLInputElement).value).toBe("/");
  });

  it("shows the search in the top bar with its key cap and names both shortcuts", async () => {
    setup();
    const { user } = renderApp("/");
    const search = await screen.findByRole("button", { name: "Search" });
    expect(search.closest(".top-bar")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" }).contains(search)).toBe(
      false,
    );
    expect(search.getAttribute("aria-keyshortcuts")).toBe("/ Control+K");
    expect(search.textContent).toContain("Ctrl+K");
    expect(search.parentElement?.querySelector(".tip")?.textContent).toBe("Search (/ or Ctrl+K)");
    await user.click(search);
    expect(await screen.findByRole("dialog", { name: /command|palette/i })).toBeTruthy();
  });

  it("offers in New only what the role may create", async () => {
    setup("editor");
    const { user } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "New" }));
    expect(
      within(screen.getByRole("menu", { name: "New" }))
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["New dashboard", "New folder", "Import dashboard"]);
    cleanup();
    setup("viewer");
    renderApp("/");
    await screen.findByRole("button", { name: "Help" });
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("offers New and Help in the top bar", async () => {
    setup("owner");
    const { user, location } = renderApp("/");
    await user.click(await screen.findByRole("button", { name: "New" }));
    const menu = screen.getByRole("menu", { name: "New" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["New dashboard", "New folder", "Import dashboard", "Add data source"]);
    await user.click(within(menu).getByRole("menuitem", { name: "New folder" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards"));
    expect(await screen.findByRole("dialog", { name: "New folder" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Help" }));
    await user.click(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});

describe("organization menu", () => {
  it("opens from the workspace card with the places of the organization", async () => {
    setup("owner");
    const { user, location } = renderApp("/");
    const card = await screen.findByRole("button", { name: "Organization Org Owner" });
    await user.click(card);
    const menu = await screen.findByRole("menu", { name: "Organization menu" });
    expect(within(menu).getByText("Your role: Owner")).toBeTruthy();
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items.slice(0, 2)).toEqual(["Organization settings", "Members"]);
    expect(document.activeElement?.textContent).toBe("Organization settings");
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(location().pathname).toBe("/admin/members"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is a plain card for a viewer, who has nothing of the organization to open", async () => {
    setup("viewer");
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() => expect(document.querySelector(".org-switcher--static")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /^Organization/ })).toBeNull();
  });
});

describe("keyboard shortcuts help", () => {
  it("opens with ?, lists every area and closes with Escape", async () => {
    setup();
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const area of [
      "Everywhere",
      "Sidebar and account menu",
      "Command palette",
      "Dashboards",
      "Explore",
      "Query editors",
    ]) {
      expect(within(dialog).getByRole("heading", { name: area })).toBeTruthy();
    }
    expect(within(dialog).getByText("Open the command palette")).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not open while typing", async () => {
    const { user } = await openPalette();
    await user.keyboard("?");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

describe("toasts", () => {
  it("announce politely, offer undo, and errors go to the alert region", async () => {
    setup();
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    let undone = false;
    act(() => {
      showToast({ message: "Saved it.", undo: () => (undone = true) });
    });
    const text = await screen.findByText("Saved it.");
    expect(text.closest('[role="status"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undone).toBe(true);
    expect(screen.queryByText("Saved it.")).toBeNull();

    act(() => {
      showToast({ message: "That failed.", error: true });
    });
    expect((await screen.findByText("That failed.")).closest('[role="alert"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("That failed.")).toBeNull();
  });
});

describe("start page", () => {
  it("shows starred and recent dashboards with their folder, and quick actions", async () => {
    const server = setup();
    server.areas.shell.stars.push({ dashboardId: "d-sales", at: 1 });
    server.areas.shell.views.push(
      { dashboardId: "d-stock", at: 2 },
      { dashboardId: "d-people", at: 3 },
    );
    renderApp("/");
    const starred = await screen.findByRole("region", { name: "Favorites" });
    const link = await within(starred).findByRole("link", { name: "Sales overview" });
    expect(link.getAttribute("href")).toBe("/dashboards/d-sales");
    // A card: its folder, Open, and the star already set for a favorite.
    const card = link.closest("li") as HTMLElement;
    expect(card.textContent).toContain("Operations");
    expect(
      within(card).getByRole("button", { name: "Favorite" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(card).getByRole("link", { name: "Open “Sales overview”" }).getAttribute("href"),
    ).toBe("/dashboards/d-sales");
    expect(
      within(card).getByRole("link", { name: "Edit “Sales overview”" }).getAttribute("href"),
    ).toBe("/dashboards/d-sales?edit=true");
    const recent = screen.getByRole("region", { name: "Recently opened" });
    await within(recent).findByRole("link", { name: /Stock/ });
    // The restricted dashboard is not listed for an editor.
    expect(within(recent).queryByRole("link", { name: /Salaries/ })).toBeNull();
    const actions = screen.getByRole("region", { name: "Quick actions" });
    expect(within(actions).getByRole("link", { name: "New dashboard" })).toBeTruthy();
    const quick = screen.getByRole("region", { name: "Quick start" });
    expect(within(quick).getByRole("button", { name: /^Search/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
  });

  it("counts what the user may see, each number a link to where it is", async () => {
    setup("owner");
    renderApp("/");
    const stats = await screen.findByRole("region", { name: "Overview" });
    // Two of the three dashboards; the restricted folder's is not counted for this role.
    const dashboards = await within(stats).findByRole("link", { name: /^Dashboards/ });
    await waitFor(() => expect(dashboards.textContent).toMatch(/\d$/));
    expect(dashboards.getAttribute("href")).toBe("/dashboards");
    expect(within(stats).getByRole("link", { name: /^Data sources/ })).toBeTruthy();
    expect(
      within(stats)
        .getByRole("link", { name: /^Members/ })
        .getAttribute("href"),
    ).toBe("/admin/members");
    expect(within(stats).getByRole("link", { name: /^Changes, 7 days/ })).toBeTruthy();
  });

  it("lists the latest changes for who may read the audit log", async () => {
    setup("owner");
    renderApp("/");
    const changes = await screen.findByRole("region", { name: "Recently changed" });
    expect(
      within(changes).getByRole("link", { name: "All in the audit log" }).getAttribute("href"),
    ).toBe("/admin/audit");
  });

  it("shows a viewer only the numbers it may see", async () => {
    const server = setup("viewer");
    renderApp("/");
    const stats = await screen.findByRole("region", { name: "Overview" });
    await within(stats).findByRole("link", { name: /^Dashboards/ });
    expect(within(stats).queryByRole("link", { name: /^Members/ })).toBeNull();
    expect(within(stats).queryByRole("link", { name: /^Changes/ })).toBeNull();
    // Without audit:read there is no list of changes, and the audit log is never asked.
    expect(screen.queryByRole("region", { name: "Recently changed" })).toBeNull();
    expect(server.calls.some((call) => call.path.includes("/audit"))).toBe(false);
  });

  it("takes a dashboard off the favorites with its star", async () => {
    const server = setup();
    server.areas.shell.stars.push({ dashboardId: "d-sales", at: 1 });
    const { user } = renderApp("/");
    const favorites = await screen.findByRole("region", { name: "Favorites" });
    const star = await within(favorites).findByRole("button", { name: "Favorite" });
    expect(star.getAttribute("aria-pressed")).toBe("true");
    await user.click(star);
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) =>
            call.method === "DELETE" && call.path === "/api/orgs/o1/dashboards/d-sales/star",
        ),
      ).toBe(true),
    );
  });

  it("guides a fresh organization with a checklist of the steps the user may take", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("owner") });
    server.areas.datasources.datasources = [];
    const { user } = renderApp("/");
    const steps = await screen.findByRole("region", { name: "First steps" });
    // In the sidebar, from real data: nothing yet but other members.
    expect(steps.closest("header")).not.toBeNull();
    const items = within(steps)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      "Add a data source, to do",
      "Create a dashboard, to do",
      "Invite a colleague, done",
    ]);
    expect(within(steps).getByText("1 of 3 done")).toBeTruthy();
    // The card offers the next step.
    await user.click(within(steps).getByRole("link", { name: "Connect a database" }));
    await screen.findByRole("heading", { level: 1, name: /data source/i });
  });

  it("hides the checklist when the user dismisses it, and keeps it hidden", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("owner") });
    server.areas.datasources.datasources = [];
    const { user, view } = renderApp("/");
    const steps = await screen.findByRole("region", { name: "First steps" });
    await user.click(within(steps).getByRole("button", { name: "Hide first steps" }));
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
    view.unmount();
    renderApp("/");
    await screen.findByRole("region", { name: "Overview" });
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
  });

  it("shows no checklist once every step is done, and stops asking for it", async () => {
    const server = setup("owner");
    renderApp("/");
    await screen.findByRole("region", { name: "Overview" });
    await waitFor(() =>
      expect(window.localStorage.getItem(SETUP_DISMISSED_KEY)).toContain(`${TEST_USER.id}:o1`),
    );
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
    // Existence checks only: one entry (two members), never a page of 200.
    const checks = server.calls.filter((call) =>
      /search\?.*limit=1\b|members\?limit=2\b/.test(call.path),
    );
    expect(checks.length).toBeGreaterThan(0);
  });

  it("keeps a dismissal to its own organization", async () => {
    window.localStorage.setItem(SETUP_DISMISSED_KEY, JSON.stringify([`${TEST_USER.id}:o2`]));
    const server = installFakeServer({ signedIn: true, user: asRole("owner") });
    server.areas.datasources.datasources = [];
    renderApp("/");
    expect(await screen.findByRole("region", { name: "First steps" })).toBeTruthy();
  });

  it("moves the checklist onto the start page while the sidebar is the rail", async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    const server = installFakeServer({ signedIn: true, user: asRole("owner") });
    server.areas.datasources.datasources = [];
    renderApp("/");
    const steps = await screen.findByRole("region", { name: "First steps" });
    expect(steps.closest("main")).not.toBeNull();
  });

  it("shows a viewer of a fresh organization no step it could not take", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.datasources = [];
    renderApp("/");
    expect(await screen.findByText(/Ask an admin/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
    expect(screen.queryByRole("link", { name: "New dashboard" })).toBeNull();
  });

  it("opens the start dashboard on entry, and the start page from the navigation", async () => {
    const server = setup();
    server.state.preferences.startDashboard = { orgId: "o1", dashboardId: "d-stock" };
    const { user, location } = renderApp("/");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-stock"));
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Home" }));
    await waitFor(() => expect(location().pathname).toBe("/"));
    expect(await screen.findByRole("region", { name: "Favorites" })).toBeTruthy();
  });
});

describe("dashboard page", () => {
  it("stars and unstars from the page, records the view and shows breadcrumbs", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
    expect(
      (await within(crumbs).findByRole("link", { name: "Operations" })).getAttribute("href"),
    ).toBe("/dashboards?folder=f-ops");
    expect(within(crumbs).getByText("Sales overview").getAttribute("aria-current")).toBe("page");
    await waitFor(() => expect(server.areas.shell.views[0]?.dashboardId).toBe("d-sales"));

    // One name in both states; aria-pressed says which.
    const star = await screen.findByRole("button", { name: "Favorite" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await user.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("true"));
    const starred = screen.getByRole("button", { name: "Favorite" });
    expect(starred).toBe(star);
    expect(server.areas.shell.stars.map((s) => s.dashboardId)).toEqual(["d-sales"]);
    await user.click(starred);
    await waitFor(() => expect(server.areas.shell.stars).toEqual([]));
  });

  it("leads from the trash, playlists, library panels and history back by breadcrumbs", async () => {
    setup();
    for (const [path, trail] of [
      ["/dashboards/trash", ["Dashboards", "Trash"]],
      ["/dashboards/playlists", ["Dashboards", "Playlists"]],
      ["/dashboards/library", ["Dashboards", "Library panels"]],
      ["/dashboards/d-sales/versions", ["Dashboards", "Sales overview", "History"]],
    ] as const) {
      renderApp(path);
      const crumbs = await screen.findByRole("navigation", { name: "Breadcrumbs" });
      await waitFor(() =>
        expect(within(crumbs).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
          ...trail,
        ]),
      );
      expect(within(crumbs).getByRole("link", { name: "Dashboards" }).getAttribute("href")).toBe(
        "/dashboards",
      );
      cleanup();
    }
  });

  it("takes a failed star back and says so", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    const star = await screen.findByRole("button", { name: "Favorite" });
    server.failNext("/api/orgs/o1/dashboards/d-sales/star", 503, "busy", "PUT");
    await user.click(star);
    expect((await screen.findByText(/server is busy/)).closest('[role="alert"]')).not.toBeNull();
    expect(
      (await screen.findByRole("button", { name: "Favorite" })).getAttribute("aria-pressed"),
    ).toBe("false");
  });
});

describe("preferences", () => {
  it("applies a change at once, saves it on the server and undoes it", async () => {
    const server = setup();
    const { user } = renderApp("/account");
    const section = await screen.findByRole("region", { name: "Preferences" });
    const theme = await within(section).findByLabelText("Theme");
    await user.selectOptions(theme, "contrast");
    expect(getTheme()).toBe("contrast");
    await waitFor(() => expect(server.state.preferences.theme).toBe("contrast"));
    expect(await screen.findByText("Theme saved.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.state.preferences.theme).toBeNull());
    expect(getTheme()).toBe("system");
  });

  it("applies the stored language and the server default after sign-in", async () => {
    const server = setup();
    server.state.preferences.language = "de";
    renderApp("/");
    await waitFor(() => expect(getLanguage()).toBe("de"));
    expect(await screen.findByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
  });

  it("chooses time zone, week start and start dashboard", async () => {
    const server = setup();
    const { user } = renderApp("/account");
    const section = await screen.findByRole("region", { name: "Preferences" });
    await user.selectOptions(await within(section).findByLabelText("Time zone"), "UTC");
    await waitFor(() => expect(server.state.preferences.timeZone).toBe("UTC"));
    await user.selectOptions(within(section).getByLabelText("First day of the week"), "sunday");
    await waitFor(() => expect(server.state.preferences.weekStart).toBe("sunday"));
    const start = within(section).getByLabelText("Start dashboard");
    await waitFor(() =>
      expect(
        within(start).getByRole("option", { name: "Operations / Sales overview" }),
      ).toBeTruthy(),
    );
    await user.selectOptions(start, "d-sales");
    await waitFor(() =>
      expect(server.state.preferences.startDashboard).toEqual({
        orgId: "o1",
        dashboardId: "d-sales",
      }),
    );
  });

  it("takes a refused change back and reports it", async () => {
    const server = setup();
    const { user } = renderApp("/account");
    const section = await screen.findByRole("region", { name: "Preferences" });
    const theme = await within(section).findByLabelText("Theme");
    server.failNext("/api/me/preferences", 422, "validation", "PATCH");
    await user.selectOptions(theme, "dark");
    expect((await screen.findByText(/did not accept/)).closest('[role="alert"]')).not.toBeNull();
    await waitFor(() => expect(getTheme()).toBe("system"));
  });
});

describe("language and theme chosen before signing in", () => {
  it("become the account's preferences where it has none, once", async () => {
    const server = setup();
    server.state.signedIn = false;
    server.state.preferences.language = null;
    server.state.preferences.defaults.language = "en";
    const { user } = renderApp("/login");
    await chooseBeforeSignIn(user, /^Language:/, "Deutsch");
    await chooseBeforeSignIn(user, /^Darstellung:/, "Dunkel");
    await user.click(screen.getByLabelText("E-Mail-Adresse"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Passwort"));
    await user.paste(TEST_PASSWORD);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(server.state.preferences.language).toBe("de"));
    expect(server.state.preferences.theme).toBe("dark");
    expect(getLanguage()).toBe("de");
    const adoptions = server.calls.filter(
      (call) => call.method === "PATCH" && call.path === "/api/me/preferences",
    );
    expect(adoptions).toHaveLength(1);
    expect(window.localStorage.getItem(LOCAL_CHOICE_KEY)).toBe("");
  });

  it("are not what the browser applied for someone: the server's default applies", async () => {
    const server = setup();
    server.state.preferences.language = null;
    server.state.preferences.defaults.language = "de";
    // Left by an earlier session, and the browser's own language list: neither is a choice.
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    renderApp("/");
    expect(await screen.findByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(server.state.preferences.language).toBeNull();
  });

  it("never pass from one user of a shared browser to the next", async () => {
    const server = setup();
    // A has German and the dark theme as preferences.
    server.state.preferences.language = "de";
    server.state.preferences.theme = "dark";
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Hauptnavigation" });
    expect(getTheme()).toBe("dark");
    await user.click(screen.getByRole("button", { name: /Konto/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Abmelden" }));
    await screen.findByLabelText("E-Mail-Adresse");

    // B has no preferences of their own; the server's default is English and system.
    server.state.user = { ...TEST_USER, id: "u2", email: "bob@example.com", name: "Bob" };
    server.state.preferences = {
      language: null,
      theme: null,
      timeZone: null,
      weekStart: null,
      startDashboard: null,
      defaults: { language: "en", theme: "system" },
    };
    const before = server.calls.length;
    await user.click(screen.getByLabelText("E-Mail-Adresse"));
    await user.paste("bob@example.com");
    await user.click(screen.getByLabelText("Passwort"));
    await user.paste(TEST_PASSWORD);
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    await waitFor(() => expect(getTheme()).toBe("system"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.calls.slice(before).some((call) => call.method === "PATCH")).toBe(false);
    expect(server.state.preferences.language).toBeNull();
  });
});
describe("time zone", () => {
  it("re-renders the times already on screen when it changes", async () => {
    const server = setup();
    server.state.preferences.timeZone = "UTC";
    renderApp("/dashboards");
    // The fake dashboards were last saved on 2026-10-01 at 00:00 UTC.
    expect(await screen.findAllByText(/Oct 1, 2026, 12:00\s?AM/)).not.toHaveLength(0);
    act(() => setTimeZone("Asia/Tokyo"));
    expect(await screen.findAllByText(/Oct 1, 2026, 9:00\s?AM/)).not.toHaveLength(0);
    expect(screen.queryByText(/Oct 1, 2026, 12:00\s?AM/)).toBeNull();
  });
});

describe("toasts against each other and the clock", () => {
  it("keep an unread error when a confirmation follows, and only confirmations time out", () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => {
        showToast({ message: "Saving failed.", error: true });
        showToast({ message: "Saved the other one." });
      });
      expect(screen.getByText("Saving failed.").closest('[role="alert"]')).not.toBeNull();
      expect(screen.getByText("Saved the other one.").closest('[role="status"]')).not.toBeNull();
      act(() => vi.advanceTimersByTime(UNDO_TOAST_MS + 1));
      expect(screen.queryByText("Saved the other one.")).toBeNull();
      expect(screen.getByText("Saving failed.")).toBeTruthy();
      // A new error takes the error's place.
      act(() => {
        showToast({ message: "Second failure.", error: true });
      });
      expect(screen.queryByText("Saving failed.")).toBeNull();
      expect(screen.getByRole("status", { name: "Notifications" })).toBeTruthy();
      expect(screen.getByRole("alert", { name: "Errors" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("return focus to where it was when Undo or Dismiss closes them", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <main id="main" tabIndex={-1}>
          content
        </main>
        <Toaster />
      </>,
    );
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    let undone = 0;
    act(() => {
      showToast({ message: "Saved.", undo: () => undone++ });
    });
    await user.tab();
    expect(document.activeElement?.textContent).toBe("Undo");
    await user.keyboard("{Enter}");
    expect(undone).toBe(1);
    expect(document.activeElement).toBe(before);

    // Reached without a place to go back to: focus lands on the content.
    act(() => {
      showToast({ message: "Failed.", error: true });
    });
    before.blur();
    screen.getByRole("button", { name: "Dismiss" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("shortcuts and editors", () => {
  /** A real CodeMirror editor in the page, as the query editors put one. */
  function codeEditor(): HTMLElement {
    const host = document.createElement("div");
    screen.getByRole("main").append(host);
    const view = new EditorView({
      parent: host,
      doc: "SELECT 1",
      extensions: [keymap.of(defaultKeymap)],
    });
    return view.contentDOM;
  }

  it("opens the palette with Ctrl+K from inside a code editor and returns focus there", async () => {
    setup();
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    const editor = codeEditor();
    editor.focus();
    fireEvent.keyDown(editor, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(editor);
  });

  it("leaves / to text fields, editable text, code editors and input methods", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const search = await screen.findByLabelText("Search dashboards");
    await user.click(search);
    await user.keyboard("/");
    expect((search as HTMLInputElement).value).toBe("/");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    screen.getByRole("main").append(editable);
    fireEvent.keyDown(editable, { key: "/" });
    fireEvent.keyDown(codeEditor(), { key: "/" });
    // A "/" that confirms an input method composition is the composition's, not a shortcut.
    fireEvent.keyDown(document.body, { key: "/", isComposing: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("does not open the help with ? from a text field or a code editor", async () => {
    setup();
    const { user } = renderApp("/dashboards");
    const search = await screen.findByLabelText("Search dashboards");
    await user.click(search);
    await user.keyboard("?");
    expect((search as HTMLInputElement).value).toBe("?");
    const editor = codeEditor();
    fireEvent.keyDown(editor, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("leaves Ctrl+K to the browser while a dialog is open", async () => {
    setup();
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(document.body, { key: "?" });
    const help = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const notPrevented = fireEvent.keyDown(help, { key: "k", ctrlKey: true });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});

/** Signs in on the sign-in page as the fake server's current user. */
async function signInHere(
  user: ReturnType<typeof renderApp>["user"],
  email: string,
  german: boolean,
) {
  await user.click(screen.getByLabelText(german ? "E-Mail-Adresse" : "Email address"));
  await user.paste(email);
  await user.click(screen.getByLabelText(german ? "Passwort" : "Password"));
  await user.paste(TEST_PASSWORD);
  await user.keyboard("{Enter}");
}

const BOB = { ...TEST_USER, id: "u2", email: "bob@example.com", name: "Bob" };

function noPreferences(language = "en") {
  return {
    language: null,
    theme: null,
    timeZone: null,
    weekStart: null,
    startDashboard: null,
    defaults: { language, theme: "system" },
  };
}

const patches = (server: ReturnType<typeof setup>, from = 0) =>
  server.calls.slice(from).filter((call) => call.method === "PATCH");

describe("sessions that end and accounts that follow", () => {
  it("do not carry the previous account's preferences to the next one after the session expired", async () => {
    const server = setup();
    server.state.preferences = { ...noPreferences(), language: "de", theme: "dark" };
    const { user, app } = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    // The session ends on the server; the next page change finds it gone.
    server.state.signedIn = false;
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await screen.findByLabelText("E-Mail-Adresse");

    // Bob chooses English on the sign-in page; he has no preferences, the default is German.
    server.state.user = BOB;
    server.state.preferences = noPreferences("de");
    await chooseBeforeSignIn(user, /^Sprache:/, "English");
    const before = server.calls.length;
    await signInHere(user, BOB.email, false);
    await waitFor(() => expect(server.state.preferences.language).toBe("en"));
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(patches(server, before).map((call) => call.body)).toEqual([{ language: "en" }]);
    // Ada's dark theme did not come along: Bob has the default.
    await waitFor(() => expect(getTheme()).toBe("system"));
    expect(window.localStorage.getItem(LOCAL_CHOICE_KEY)).toBe("");
    // Nothing cached for Ada is left to answer for Bob.
    expect(app.queryClient.getQueryData(["preferences", TEST_USER.id])).toBeUndefined();
  });

  it("keep a choice whose saving failed with its account, never with the next one", async () => {
    const server = setup();
    server.state.signedIn = false;
    server.state.preferences = noPreferences("en");
    const { user } = renderApp("/login");
    await chooseBeforeSignIn(user, /^Language:/, "Deutsch");
    server.failNext("/api/me/preferences", 503, "busy", "PATCH");
    await signInHere(user, TEST_USER.email, true);
    await screen.findByRole("navigation", { name: "Hauptnavigation" });
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    // Not saved, still shown: the choice applies until it is the account's preference.
    expect(server.state.preferences.language).toBeNull();
    expect(getLanguage()).toBe("de");
    expect(JSON.parse(window.localStorage.getItem(LOCAL_CHOICE_KEY) ?? "{}")).toEqual({
      language: "de",
      userId: TEST_USER.id,
    });

    // The session expires; Bob signs in next and takes nothing over.
    server.state.signedIn = false;
    const nav = screen.getByRole("navigation", { name: "Hauptnavigation" });
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await screen.findByLabelText("E-Mail-Adresse");
    server.state.user = BOB;
    server.state.preferences = noPreferences("en");
    const before = server.calls.length;
    await signInHere(user, BOB.email, true);
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches(server, before)).toEqual([]);
    expect(window.localStorage.getItem(LOCAL_CHOICE_KEY)).toBe("");
  });

  it("forget the choice on sign-out", async () => {
    const server = setup();
    server.state.preferences = noPreferences("en");
    window.localStorage.setItem(
      LOCAL_CHOICE_KEY,
      JSON.stringify({ language: "de", userId: TEST_USER.id }),
    );
    server.failNext("/api/me/preferences", 503, "busy", "PATCH");
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Hauptnavigation" });
    await user.click(screen.getByRole("button", { name: /Konto/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Abmelden" }));
    await screen.findByLabelText("E-Mail-Adresse");
    expect(window.localStorage.getItem(LOCAL_CHOICE_KEY)).toBe("");
  });

  it("never apply a choice another account claimed", async () => {
    const server = setup();
    server.state.user = BOB;
    server.state.preferences = noPreferences("en");
    window.localStorage.setItem(
      LOCAL_CHOICE_KEY,
      JSON.stringify({ language: "de", theme: "dark", userId: TEST_USER.id }),
    );
    renderApp("/");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(getTheme()).toBe("system");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches(server)).toEqual([]);
  });

  it("leave no choice behind for an account with preferences of its own", async () => {
    const server = setup();
    window.localStorage.setItem(LOCAL_CHOICE_KEY, JSON.stringify({ language: "de" }));
    renderApp("/");
    expect(await screen.findByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(LOCAL_CHOICE_KEY)).toBe(""));
    expect(patches(server)).toEqual([]);
  });

  it("keep a change made while the first preferences are still on their way", async () => {
    const server = setup();
    server.state.preferences = noPreferences("en");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/me/preferences" && (init?.method ?? "GET") === "GET") {
        const answer = await fake(input, init);
        await gate;
        return answer;
      }
      return fake(input, init);
    });
    // Not the start page, which waits for the preferences (a start dashboard may open instead).
    const { user } = renderApp("/dashboards");
    await screen.findByRole("navigation", { name: "Main navigation" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.paste("dark");
    // Once the pause in typing is over, the list is rebuilt as ranked results; pick from that.
    await waitFor(() => expect(options(dialog)).not.toContain("New dashboard"));
    await user.click(await within(dialog).findByRole("option", { name: /Theme: Dark/ }));
    await waitFor(() => expect(getTheme()).toBe("dark"));
    // The first answer (theme unset, so the default "system") arrives after the change.
    release();
    await waitFor(() => expect(server.state.preferences.theme).toBe("dark"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getTheme()).toBe("dark");
  });
});

describe("a preference change on its way", () => {
  it("is not undone by preferences fetched again meanwhile", async () => {
    const server = setup();
    server.state.preferences = noPreferences("en");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await fake(input, init);
      if (String(input) === "/api/me/preferences" && init?.method === "PATCH") {
        await gate;
      }
      return answer;
    });
    const { user, app } = renderApp("/dashboards");
    await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() =>
      expect(app.queryClient.getQueryData(["preferences", TEST_USER.id])).toBeDefined(),
    );
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.paste("dark");
    // Once the pause in typing is over, the list is rebuilt as ranked results; pick from that.
    await waitFor(() => expect(options(dialog)).not.toContain("New dashboard"));
    await user.click(await within(dialog).findByRole("option", { name: /Theme: Dark/ }));
    // While the change is on its way, the preferences are read again (another tab, a refetch).
    await act(() => app.queryClient.refetchQueries({ queryKey: ["preferences", TEST_USER.id] }));
    expect(getTheme()).toBe("dark");
    release();
    await waitFor(() => expect(server.state.preferences.theme).toBe("dark"));
    expect(getTheme()).toBe("dark");
  });
});
describe("the choice made before signing in, as stored", () => {
  it("knows only languages and themes the UI has", () => {
    window.localStorage.setItem(
      LOCAL_CHOICE_KEY,
      JSON.stringify({ language: "fr", theme: "pink" }),
    );
    expect(choiceFor("u1")).toEqual({});
    window.localStorage.setItem(LOCAL_CHOICE_KEY, "not json");
    expect(choiceFor("u1")).toEqual({});
  });

  it("starts anew when the stored choice belongs to an account", () => {
    window.localStorage.setItem(LOCAL_CHOICE_KEY, JSON.stringify({ language: "de", userId: "u1" }));
    recordChoice({ theme: "dark" });
    expect(choiceFor("u2")).toEqual({ theme: "dark" });
    recordChoice({ language: "en" });
    expect(choiceFor("u2")).toEqual({ theme: "dark", language: "en" });
  });
});
