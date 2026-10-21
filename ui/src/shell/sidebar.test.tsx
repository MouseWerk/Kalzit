import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { NAV_GROUPS_STORAGE_KEY, SIDEBAR_STORAGE_KEY } from "./sidebarState";

const ORG_ADMIN = {
  ...TEST_USER,
  isServerAdmin: false,
  orgs: [{ id: "o1", name: "Analytical Engines", role: "owner" }],
};

async function openShell(path = "/", user = TEST_USER) {
  installFakeServer({ signedIn: true, user });
  const rendered = renderApp(path);
  const nav = await screen.findByRole("navigation", { name: "Main navigation" });
  const toggle = screen.getByRole("button", { name: "Sidebar" });
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
    ).toEqual(["Members", "Roles", "Organization settings", "Audit log"]);
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
    const entry = within(nav).getByRole("link", { name: "Administration" });
    expect(entry.getAttribute("aria-current")).toBe("true");

    // Navigating into the group from outside opens it again.
    await user.click(within(nav).getByRole("button", { name: "Administration sections" }));
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
    await within(list).findByRole("link", { name: "Members" });
    expect(within(list).queryByRole("list", { name: "Server" })).toBeNull();
    expect(within(list).queryByRole("link", { name: "Server settings" })).toBeNull();
  });

  it("lists the server sections alone for a server admin without an organization", async () => {
    const { nav } = await openShell("/admin", { ...TEST_USER, orgs: [] });
    const list = await within(nav).findByRole("list", { name: "Administration sections" });
    expect(within(list).queryByRole("list", { name: "Organization" })).toBeNull();
    const server = within(list).getByRole("list", { name: "Server" });
    expect(within(server).getAllByRole("link")).toHaveLength(4);
  });

  it("keeps entries without sub-pages plain links", async () => {
    const { nav } = await openShell("/");
    expect(within(nav).getAllByRole("button")).toHaveLength(1);
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

  it("opens on hover and closes when the pointer leaves or clicks elsewhere", async () => {
    const { user, nav } = await openRail();
    const entry = within(nav).getByRole("link", { name: "Administration" });
    await user.hover(entry);
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    expect(within(list).getByRole("link", { name: "Members" })).toBeTruthy();

    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();

    await user.hover(entry);
    expect(within(nav).getByRole("list", { name: "Administration sections" })).toBeTruthy();
    await user.unhover(entry);
    await waitFor(() =>
      expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull(),
    );
  });

  it("opens on keyboard focus, takes Tab into its links and closes on Escape", async () => {
    const { user, nav } = await openRail();
    const entry = within(nav).getByRole("link", { name: "Administration" });
    act(() => entry.focus());
    const list = within(nav).getByRole("list", { name: "Administration sections" });
    await user.tab();
    expect(document.activeElement).toBe(within(list).getByRole("link", { name: "Members" }));

    await user.keyboard("{Escape}");
    expect(within(nav).queryByRole("list", { name: "Administration sections" })).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it("navigates from the flyout and closes it", async () => {
    const { user, nav, location } = await openRail();
    await user.hover(within(nav).getByRole("link", { name: "Administration" }));
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
