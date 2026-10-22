import { defaultKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/Toaster";
import { emptyModel } from "../features/dashboards/model";
import { addDashboard, addFolder } from "../features/dashboards/test/fakeDashboards";
import { getLanguage, LANGUAGE_STORAGE_KEY } from "../i18n/i18n";
import { setTimeZone } from "../lib/timeSettings";
import { showToast, UNDO_TOAST_MS } from "../lib/toasts";
import { adoptedKey } from "../preferences/preferences";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { getTheme, THEME_STORAGE_KEY } from "../theme/theme";
import { SEARCH_DELAY_MS } from "./CommandPalette";
import { fuzzyScore } from "./fuzzy";

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
    expect(within(listbox).getByRole("group", { name: "Actions" })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: "Go to" })).toBeTruthy();
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
    const { dialog, user, server } = await openPalette();
    await user.paste("dark");
    const dark = await within(dialog).findByRole("option", { name: /Theme: Dark/ });
    await user.click(dark);
    expect(getTheme()).toBe("dark");
    await waitFor(() => expect(server.state.preferences.theme).toBe("dark"));
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
    const starred = await screen.findByRole("region", { name: "Starred dashboards" });
    const link = await within(starred).findByRole("link", { name: /Sales overview/ });
    expect(link.getAttribute("href")).toBe("/dashboards/d-sales");
    expect(link.textContent).toContain("Operations");
    const recent = screen.getByRole("region", { name: "Recently opened" });
    await within(recent).findByRole("link", { name: /Stock/ });
    // The restricted dashboard is not listed for an editor.
    expect(within(recent).queryByRole("link", { name: /Salaries/ })).toBeNull();
    const actions = screen.getByRole("region", { name: "Quick actions" });
    expect(within(actions).getByRole("link", { name: "New dashboard" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "First steps" })).toBeNull();
  });

  it("guides a fresh organization with the steps the user may take", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("owner") });
    server.areas.datasources.datasources = [];
    renderApp("/");
    const steps = await screen.findByRole("region", { name: "First steps" });
    expect(within(steps).getByRole("heading", { name: "Add a data source" })).toBeTruthy();
    expect(within(steps).getByRole("heading", { name: "Create a dashboard" })).toBeTruthy();
    expect(within(steps).getByRole("heading", { name: "Invite members" })).toBeTruthy();
  });

  it("shows a viewer of a fresh organization no step it could not take", async () => {
    const server = installFakeServer({ signedIn: true, user: asRole("viewer") });
    server.areas.datasources.datasources = [];
    renderApp("/");
    const steps = await screen.findByRole("region", { name: "First steps" });
    expect(within(steps).queryByRole("heading", { level: 3 })).toBeNull();
    expect(within(steps).getByText(/Ask an admin/)).toBeTruthy();
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
    expect(await screen.findByRole("region", { name: "Starred dashboards" })).toBeTruthy();
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

    const star = await screen.findByRole("button", { name: "Star" });
    expect(star.getAttribute("aria-pressed")).toBe("false");
    await user.click(star);
    const starred = await screen.findByRole("button", { name: "Starred" });
    expect(starred.getAttribute("aria-pressed")).toBe("true");
    expect(server.areas.shell.stars.map((s) => s.dashboardId)).toEqual(["d-sales"]);
    await user.click(starred);
    await waitFor(() => expect(server.areas.shell.stars).toEqual([]));
  });

  it("takes a failed star back and says so", async () => {
    const server = setup();
    const { user } = renderApp("/dashboards/d-sales");
    const star = await screen.findByRole("button", { name: "Star" });
    server.failNext("/api/orgs/o1/dashboards/d-sales/star", 503, "busy", "PUT");
    await user.click(star);
    expect((await screen.findByText(/server is busy/)).closest('[role="alert"]')).not.toBeNull();
    expect((await screen.findByRole("button", { name: "Star" })).getAttribute("aria-pressed")).toBe(
      "false",
    );
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

describe("language and theme the browser already has", () => {
  it("are kept and adopted once into the server's empty preferences", async () => {
    const server = setup();
    server.state.preferences.language = null;
    server.state.preferences.defaults.language = "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderApp("/");
    await waitFor(() => expect(server.state.preferences.language).toBe("de"));
    expect(server.state.preferences.theme).toBe("dark");
    expect(getLanguage()).toBe("de");
    expect(getTheme()).toBe("dark");
    const adoptions = server.calls.filter(
      (call) => call.method === "PATCH" && call.path === "/api/me/preferences",
    );
    expect(adoptions).toHaveLength(1);
  });

  it("are not adopted again once a preference was reset to the default", async () => {
    const server = setup();
    server.state.preferences.language = null;
    server.state.preferences.defaults.language = "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "de");
    window.localStorage.setItem(adoptedKey(TEST_USER.id), "true");
    renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    await waitFor(() => expect(getLanguage()).toBe("en"));
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("leave the server's default when the browser has none", async () => {
    const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"]);
    try {
      const server = setup();
      server.state.preferences.language = null;
      server.state.preferences.defaults.language = "de";
      renderApp("/");
      expect(await screen.findByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
      expect(server.state.preferences.language).toBeNull();
    } finally {
      languages.mockRestore();
    }
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
