import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openLayerCount } from "../lib/layers";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { stubMatchMedia } from "../test/matchMedia";
import { renderApp } from "../test/renderApp";
import {
  NAV_GROUPS_STORAGE_KEY,
  SIDEBAR_FOCUS_STORAGE_KEY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "./sidebarState";

const ORG_ADMIN = {
  ...TEST_USER,
  isServerAdmin: false,
  orgs: [{ id: "o1", name: "Analytical Engines", role: "owner" }],
};

async function openShell(path = "/", user = TEST_USER) {
  installFakeServer({ signedIn: true, user });
  const rendered = renderApp(path);
  const nav = await screen.findByRole("navigation", { name: "Main navigation" });
  // In the content header; left out where the sidebar is a bar on top.
  const toggle = screen.queryByRole("button", { name: "Sidebar" }) as HTMLElement;
  const shell = document.querySelector<HTMLElement>(".shell");
  if (shell === null) {
    throw new Error("no shell");
  }
  return { ...rendered, nav, toggle, shell };
}

describe("collapsible sidebar", () => {
  it("starts expanded, collapses to the rail with its toggle and remembers it", async () => {
    const { user, toggle, shell } = await openShell();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByRole("banner").getAttribute("id"),
    );
    expect(shell.dataset.sidebar).toBe("expanded");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(shell.dataset.sidebar).toBe("collapsed");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");

    // A new page view starts collapsed; the labels stay the links' accessible names.
    cleanup();
    const again = await openShell();
    expect(again.shell.dataset.sidebar).toBe("collapsed");
    expect(again.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(again.nav).getByRole("link", { name: "Dashboards" }).title).toBe("Dashboards");

    await again.user.click(again.toggle);
    expect(again.shell.dataset.sidebar).toBe("expanded");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("false");
  });

  it("works when the browser refuses storage, starting expanded", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      const { user, toggle, shell } = await openShell("/admin/teams");
      expect(shell.dataset.sidebar).toBe("expanded");
      await user.click(toggle);
      expect(shell.dataset.sidebar).toBe("collapsed");
      expect(setItem).toHaveBeenCalled();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("toggles with Ctrl+B, but not while typing or while a menu is open", async () => {
    const { user, shell } = await openShell("/account");
    await user.keyboard("{Control>}b{/Control}");
    expect(shell.dataset.sidebar).toBe("collapsed");
    await user.keyboard("{Control>}b{/Control}");
    expect(shell.dataset.sidebar).toBe("expanded");

    // In a text field Ctrl+B belongs to the field.
    const field = await screen.findByLabelText("Name");
    await user.click(field);
    await user.keyboard("{Control>}b{/Control}");
    expect(shell.dataset.sidebar).toBe("expanded");

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    document.body.append(editable);
    try {
      editable.focus();
      await user.keyboard("{Control>}b{/Control}");
      expect(shell.dataset.sidebar).toBe("expanded");
    } finally {
      editable.remove();
    }

    // The account menu is a layer; the shortcut waits until it is closed.
    await user.click(screen.getByRole("button", { name: /Account/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Control>}b{/Control}");
    expect(shell.dataset.sidebar).toBe("expanded");
  });

  it("leaves Ctrl+B to code editors, also read-only ones", async () => {
    const { user, shell } = await openShell();
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const content = document.createElement("div");
    content.tabIndex = 0;
    editor.append(content);
    document.body.append(editor);
    try {
      content.focus();
      await user.keyboard("{Control>}b{/Control}");
      expect(shell.dataset.sidebar).toBe("expanded");
    } finally {
      editor.remove();
    }
  });

  it("takes the physical B key on layouts without a Latin B", async () => {
    const { shell } = await openShell();
    act(() => {
      fireEvent.keyDown(document.body, { key: "и", code: "KeyB", ctrlKey: true });
    });
    expect(shell.dataset.sidebar).toBe("collapsed");
  });

  it("puts the toggle at the top left of the content, before the breadcrumbs", async () => {
    const { toggle, user, shell } = await openShell("/admin/members");
    const header = toggle.closest(".shell__header");
    expect(header?.closest("main")).not.toBeNull();
    const crumbs = await within(header as HTMLElement).findByRole("navigation", {
      name: "Breadcrumbs",
    });
    expect(toggle.compareDocumentPosition(crumbs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute("aria-controls")).toBe(document.querySelector("header")?.id);
    expect(toggle.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(toggle.getAttribute("title")).toContain("Ctrl+B");
    // It stays in the header with the rail, and brings the column back.
    await user.click(toggle);
    expect(shell.dataset.sidebar).toBe("collapsed");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.closest("main")).not.toBeNull();
    await user.click(toggle);
    expect(shell.dataset.sidebar).toBe("expanded");
  });

  it("has no rail on narrow screens, and Ctrl+B does nothing there", async () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    const layout = stubMatchMedia(false);
    const { user, shell, toggle } = await openShell();
    expect(shell.dataset.sidebar).toBe("expanded");
    expect(toggle).toBeNull();
    await user.keyboard("{Control>}b{/Control}");
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
    // Wide again, the remembered rail comes back.
    layout.set(true);
    expect(shell.dataset.sidebar).toBe("collapsed");
  });

  it("ignores B with other modifiers", async () => {
    const { user, shell } = await openShell();
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    await user.keyboard("{Alt>}b{/Alt}");
    await user.keyboard("b");
    expect(shell.dataset.sidebar).toBe("expanded");
  });
});

describe("sub-pages in the navigation", () => {
  it("expands and collapses an entry's sub-pages with its chevron and remembers it", async () => {
    const { user, nav } = await openShell("/");
    const chevron = within(nav).getByRole("button", { name: "Administration sections" });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();

    await user.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("true");
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    expect(chevron.getAttribute("aria-controls")).toBe(list.id);
    expect(JSON.parse(window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY) ?? "{}")).toEqual({
      "/admin": true,
    });

    // Groups are headed and list their sections.
    const org = within(list).getByRole("list", { name: "Organization" });
    expect(
      within(org)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Roles", "Organization settings", "Audit log"]);
    // Members has its own entry in the organization group above.
    const orgGroup = within(nav)
      .getAllByRole("list", { name: "Organization" })
      .find((group) => !list.contains(group)) as HTMLElement;
    expect(within(orgGroup).getByRole("link", { name: "Members" })).toBeTruthy();
    expect(within(list).getAllByRole("list", { name: "Server" })).toHaveLength(1);
    // Sub-pages have no icon, so the rail and phones must not hide their labels as they do the
    // entries' (.nav-link__label).
    for (const link of within(list).getAllByRole("link")) {
      expect(link.querySelector(".nav-link__label")).toBeNull();
      expect(link.querySelector(".nav-sublink__label")?.textContent).toBe(link.textContent);
    }

    await user.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(NAV_GROUPS_STORAGE_KEY) ?? "{}")).toEqual({
      "/admin": false,
    });
  });

  it("opens the group of the current page and marks the page and its entry", async () => {
    const { user, nav, location } = await openShell("/admin/roles");
    const list = await within(nav).findByRole("list", { name: "Administration sections" });
    const roles = within(list).getByRole("link", { name: "Roles" });
    await waitFor(() => expect(roles.getAttribute("aria-current")).toBe("page"));
    // With the current page in view, the entry is not marked a second time.
    const entry = within(nav).getByRole("link", { name: "Administration" });
    expect(entry.getAttribute("aria-current")).toBeNull();
    const chevron = within(nav).getByRole("button", { name: "Administration sections" });
    expect(chevron.getAttribute("aria-controls")).toBe(list.id);

    // Collapsed, the group hides the page, so the entry stands for it.
    await user.click(chevron);
    expect(entry.getAttribute("aria-current")).toBe("true");
    expect(chevron.hasAttribute("aria-controls")).toBe(false);

    // Navigating into the group from outside opens it again.
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards"));
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    await user.click(within(nav).getByRole("link", { name: "Administration" }));
    await waitFor(() => expect(location().pathname).toBe("/admin"));
    expect(within(nav).getByRole("list", { name: "Administration sections" })).toBeTruthy();
    expect(entry.getAttribute("aria-current")).toBe("page");
  });

  it("lists only the sections the user may open", async () => {
    const { nav } = await openShell("/admin", ORG_ADMIN);
    const list = await within(nav).findByRole("list", { name: "Administration sections" });
    await within(list).findByRole("link", { name: "Roles" });
    expect(within(nav).getByRole("link", { name: "Members" })).toBeTruthy();
    expect(within(list).queryByRole("list", { name: "Server" })).toBeNull();
    expect(within(list).queryByRole("link", { name: "Server settings" })).toBeNull();
  });

  it("lists the server sections alone for a server admin without an organization", async () => {
    const { nav } = await openShell("/admin", { ...TEST_USER, orgs: [] });
    const list = await within(nav).findByRole("list", { name: "Administration sections" });
    expect(within(list).queryByRole("list", { name: "Organization" })).toBeNull();
    const server = within(list).getByRole("list", { name: "Server" });
    // Users, organizations, settings, updates, instances, audit log and usage of every organization.
    expect(within(server).getAllByRole("link")).toHaveLength(7);
  });

  it("keeps the current group's sub-pages reachable when the layout narrows", async () => {
    const layout = stubMatchMedia(true);
    const { user, nav } = await openShell("/admin/roles");
    await within(nav).findByRole("list", { name: "Administration sections" });
    await user.click(within(nav).getByRole("button", { name: "Administration sections" }));
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    // The bar on top has no chevron to open it again, so it shows the current group's pages.
    layout.set(false);
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    expect(within(list).getByRole("link", { name: "Roles" })).toBeTruthy();
  });

  it("keeps entries without sub-pages plain links", async () => {
    const { nav } = await openShell("/");
    // Only the entries with sub-pages (Explore, the administration) open a list; the button of
    // the pinned area is no entry. The navigation is complete from its first frame.
    const buttons = within(nav).getAllByRole("button");
    const toggles = buttons.filter((button) => button.hasAttribute("aria-expanded"));
    expect(toggles.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Explore sections",
      "Administration sections",
    ]);
    // Every other button belongs to the pinned area, none to an entry.
    const others = buttons.filter((button) => !button.hasAttribute("aria-expanded"));
    expect(others.length).toBeGreaterThan(0);
    for (const button of others) {
      expect(button.closest(".shell__pins"), button.textContent ?? "").not.toBeNull();
    }
    expect(within(nav).getByRole("link", { name: "Dashboards" })).toBeTruthy();
  });
});

describe("flyout in the rail", () => {
  async function openRail(path = "/") {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "true");
    const opened = await openShell(path);
    expect(opened.shell.dataset.sidebar).toBe("collapsed");
    // The rail has no chevrons; the flyout takes their place.
    expect(within(opened.nav).queryByRole("button")).toBeNull();
    return opened;
  }

  it("peeks the full sidebar over the page on hover, and slides back on leaving or a click elsewhere", async () => {
    const { user, nav, shell } = await openRail();
    const entry = within(nav).getByRole("link", { name: "Administration" });
    await user.hover(entry);
    // The whole sidebar, with its chevrons, while the page keeps the rail's column.
    await waitFor(() => expect(shell.dataset.peek).toBe("open"));
    expect(shell.dataset.sidebar).toBe("expanded");
    expect(shell.dataset.layout).toBe("rail");
    expect(within(nav).getAllByRole("button").length).toBeGreaterThan(0);
    // No flyout on top of it.
    expect(document.querySelector(".nav-flyout")).toBeNull();

    await user.click(screen.getByRole("heading", { level: 1 }));
    await waitFor(() => expect(shell.dataset.sidebar).toBe("collapsed"));
    expect(shell.dataset.peek).toBeUndefined();

    await user.hover(entry);
    await waitFor(() => expect(shell.dataset.peek).toBe("open"));
    await user.unhover(entry);
    await waitFor(() => expect(shell.dataset.sidebar).toBe("collapsed"));
  });

  it("opens on keyboard focus, takes Tab into its links and closes on Escape", async () => {
    const { user, nav } = await openRail();
    const entry = within(nav).getByRole("link", { name: "Administration" });
    act(() => within(nav).getByRole("link", { name: "Settings" }).focus());
    await user.tab();
    expect(document.activeElement).toBe(entry);
    expect(entry.getAttribute("aria-expanded")).toBe("true");
    // Opened from the keyboard, it is a layer that takes Escape.
    expect(openLayerCount()).toBe(1);
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    await user.tab();
    expect(document.activeElement).toBe(within(list).getByRole("link", { name: "Roles" }));

    await user.keyboard("{Escape}");
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    expect(document.activeElement).toBe(entry);
    expect(entry.getAttribute("aria-expanded")).toBe("false");
    expect(openLayerCount()).toBe(0);
  });

  it("closes the peek on Escape without making it a layer", async () => {
    const { user, nav, shell } = await openRail();
    await user.hover(within(nav).getByRole("link", { name: "Administration" }));
    await waitFor(() => expect(shell.dataset.peek).toBe("open"));
    expect(openLayerCount()).toBe(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(shell.dataset.sidebar).toBe("collapsed"));
  });

  it.each(["hover", "keyboard"])(
    "stays closed after leaving and returning to the rail (opened by %s)",
    async (how) => {
      const { user, nav, shell } = await openRail();
      const entry = within(nav).getByRole("link", { name: "Administration" });
      if (how === "hover") {
        // A hover peeks the whole sidebar instead of a flyout.
        await user.hover(entry);
        await waitFor(() => expect(shell.dataset.peek).toBe("open"));
      } else {
        act(() => within(nav).getByRole("link", { name: "Settings" }).focus());
        await user.tab();
        expect(within(nav).getByRole("list", { name: "Administration sections" })).toBeTruthy();
      }
      await user.keyboard("{Control>}b{/Control}");
      expect(shell.dataset.sidebar).toBe("expanded");
      await user.keyboard("{Control>}b{/Control}");
      expect(shell.dataset.sidebar).toBe("collapsed");
      expect(shell.dataset.peek).toBeUndefined();
      expect(document.querySelector(".nav-flyout")).toBeNull();
      expect(openLayerCount()).toBe(0);
    },
  );

  it("places the flyout next to the rail again when the window is resized", async () => {
    const { user, nav } = await openRail();
    let railRight = 56;
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const right = this.classList.contains("shell__sidebar") ? railRight : 0;
      return DOMRect.fromRect({ x: 0, y: 100, width: right, height: 30 });
    });
    try {
      act(() => within(nav).getByRole("link", { name: "Settings" }).focus());
      await user.tab();
      const flyout = document.querySelector<HTMLElement>(".nav-flyout");
      expect(flyout?.style.left).toBe("60px");
      railRight = 80;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(flyout?.style.left).toBe("84px");
    } finally {
      rect.mockRestore();
    }
  });

  it("shows a tooltip on keyboard focus and names the account on its button", async () => {
    const { user, nav, shell } = await openRail();
    act(() => within(nav).getByRole("link", { name: "Home" }).focus());
    await user.tab();
    expect(document.activeElement).toBe(within(nav).getByRole("link", { name: "Dashboards" }));
    expect(document.querySelector(".rail-tooltip")?.textContent).toBe("Dashboards");
    // Explore has sub-pages (the saved analyses), so it shows its flyout instead (below); a
    // plain entry further down has its tooltip as Dashboards does.
    act(() => within(nav).getByRole("link", { name: "Settings" }).focus());
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(nav).getByRole("link", { name: "Members" }));
    expect(document.querySelector(".rail-tooltip")?.textContent).toBe("Members");

    // Escape hides it without taking the key from the page; the next focus shows one again.
    const seen: boolean[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.defaultPrevented);
    window.addEventListener("keydown", listener);
    try {
      await user.keyboard("{Escape}");
    } finally {
      window.removeEventListener("keydown", listener);
    }
    expect(seen).toEqual([false]);
    expect(document.querySelector(".rail-tooltip")).toBeNull();
    await user.tab({ shift: true });
    expect(document.querySelector(".rail-tooltip")?.textContent).toBe("Data sources");
    // It is placed once, so scrolling the rail hides it instead of leaving it behind.
    fireEvent.scroll(nav);
    expect(document.querySelector(".rail-tooltip")).toBeNull();
    await user.tab();
    await user.tab({ shift: true });
    expect(document.querySelector(".rail-tooltip")?.textContent).toBe("Data sources");
    // A pointer gets the native title instead, never both.
    await user.hover(within(nav).getByRole("link", { name: "Dashboards" }));
    expect(document.querySelector(".rail-tooltip")).toBeNull();
    // (The hover peeks the whole sidebar; back to the rail for the keyboard.)
    await user.unhover(within(nav).getByRole("link", { name: "Dashboards" }));
    await waitFor(() => expect(shell.dataset.sidebar).toBe("collapsed"));
    act(() => within(nav).getByRole("link", { name: "Dashboards" }).focus());
    await user.tab();
    // Entries with sub-pages show their flyout instead; Explore's flyout holds one link.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(within(nav).getByRole("link", { name: "Administration" }));
    expect(document.querySelector(".rail-tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: /Account/ }).title).toBe(TEST_USER.name);
  });

  it("navigates from the flyout and closes it", async () => {
    const { user, nav, location } = await openRail();
    act(() => within(nav).getByRole("link", { name: "Settings" }).focus());
    await user.tab();
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    await user.click(within(list).getByRole("link", { name: "Roles" }));
    await waitFor(() => expect(location().pathname).toBe("/admin/roles"));
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    // The entry the page lies in is marked, since its sub-pages are not in view.
    expect(
      within(nav).getByRole("link", { name: "Administration" }).getAttribute("aria-current"),
    ).toBe("true");
  });

  it("keeps F6 and Ctrl+B working while the flyout is open", async () => {
    const { user, nav, shell } = await openRail("/admin/teams");
    screen.getByRole("main").focus();
    await user.keyboard("{F6}");
    const entry = within(nav).getByRole("link", { name: "Administration" });
    expect(document.activeElement).toBe(entry);
    expect(within(nav).getByRole("list", { name: "Administration sections" })).toBeTruthy();

    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();

    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(entry);
    await user.keyboard("{Control>}b{/Control}");
    expect(shell.dataset.sidebar).toBe("expanded");
  });
});

describe("focus mode and width", () => {
  it("hides the sidebar completely with Ctrl+Shift+B, peeks it in for F6, and brings it back", async () => {
    const { user, toggle, shell, nav } = await openShell();
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(shell.dataset.layout).toBe("hidden");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(SIDEBAR_FOCUS_STORAGE_KEY)).toBe("true");
    expect(document.querySelector(".shell__edge")).not.toBeNull();

    // The keyboard still reaches the navigation: it peeks in to take the focus.
    screen.getByRole("main").focus();
    await user.keyboard("{F6}");
    expect(shell.dataset.peek).toBe("open");
    expect(nav.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(shell.dataset.peek).toBeUndefined());

    // The toggle (and Ctrl+B) end focus mode first.
    await user.click(toggle);
    expect(shell.dataset.layout).toBe("column");
    expect(window.localStorage.getItem(SIDEBAR_FOCUS_STORAGE_KEY)).toBe("false");
  });

  it("opens from the window's edge on hover in focus mode", async () => {
    window.localStorage.setItem(SIDEBAR_FOCUS_STORAGE_KEY, "true");
    const { user, shell } = await openShell();
    const edge = document.querySelector<HTMLElement>(".shell__edge");
    if (edge === null) throw new Error("no edge");
    await user.hover(edge);
    await waitFor(() => expect(shell.dataset.peek).toBe("open"));
  });

  it("sets the width with the arrow keys on the edge, remembers it, and collapses on Enter", async () => {
    const { user, shell } = await openShell();
    const edge = screen.getByRole("separator", { name: "Sidebar width" });
    act(() => edge.focus());
    await user.keyboard("{End}");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_MAX_WIDTH));
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe(`${SIDEBAR_MAX_WIDTH}px`);
    expect(edge.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_MAX_WIDTH));
    await user.keyboard("{ArrowLeft}");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(SIDEBAR_MAX_WIDTH - 16),
    );
    await user.keyboard("{Enter}");
    expect(shell.dataset.sidebar).toBe("collapsed");
    // The rail has no edge to drag.
    expect(screen.queryByRole("separator", { name: "Sidebar width" })).toBeNull();
  });
  it("keeps the width on a plain click of the edge and ignores a broken stored width", async () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "");
    const { shell } = await openShell();
    expect(shell.style.getPropertyValue("--sidebar-width")).toBe("");
    const edge = screen.getByRole("separator", { name: "Sidebar width" });
    expect(edge.getAttribute("aria-controls")).toBe(document.querySelector(".shell__sidebar")?.id);
    fireEvent.pointerDown(edge, { button: 0, clientX: 240, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 240, pointerId: 1 });
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("");
    expect(shell.dataset.sidebar).toBe("expanded");
  });

  it("has no edge to drag and no focus mode where the sidebar is a bar on top", async () => {
    stubMatchMedia(false);
    const { user, shell } = await openShell();
    expect(screen.queryByRole("separator", { name: "Sidebar width" })).toBeNull();
    await user.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
    expect(shell.dataset.layout).toBe("column");
    expect(window.localStorage.getItem(SIDEBAR_FOCUS_STORAGE_KEY)).toBeNull();
  });

  it("gives the focus back to the page when the peek closes in focus mode", async () => {
    window.localStorage.setItem(SIDEBAR_FOCUS_STORAGE_KEY, "true");
    const { user, shell, nav } = await openShell();
    screen.getByRole("main").focus();
    await user.keyboard("{F6}");
    expect(nav.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(shell.dataset.peek).toBeUndefined());
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
