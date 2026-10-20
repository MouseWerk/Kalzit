import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "../i18n/i18n";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { THEME_STORAGE_KEY } from "../theme/theme";

async function openShell(path = "/", user = TEST_USER, rolePermissions?: Record<string, string[]>) {
  const server = installFakeServer({
    signedIn: true,
    user,
    ...(rolePermissions === undefined ? {} : { rolePermissions }),
  });
  const rendered = renderApp(path);
  await screen.findByRole("navigation", { name: "Main navigation" });
  const menuButton = screen.getByRole("button", { name: /Account/ });
  return { ...rendered, menuButton, server };
}

describe("app shell", () => {
  it("has banner, navigation and main landmarks", async () => {
    await openShell();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("marks the current page in the navigation", async () => {
    await openShell("/explore");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Explore" }).getAttribute("aria-current")).toBe(
        "page",
      ),
    );
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("gives every navigation link a name and a tooltip for the icon-only phone layout", async () => {
    await openShell();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.getAttribute("title")).toBe(link.textContent);
      expect(link.querySelector(".nav-link__label")?.textContent).toBe(link.textContent);
    }
  });

  it("shows the empty states of the placeholder pages", async () => {
    const { user } = await openShell();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const pages: [string, string][] = [
      ["Dashboards", "No dashboards yet"],
      ["Explore", "Explore is not available yet"],
      ["Data sources", "No data sources yet"],
      ["Administration", "Nothing to manage yet"],
    ];
    for (const [link, emptyTitle] of pages) {
      await user.click(within(nav).getByRole("link", { name: link }));
      expect(await screen.findByRole("heading", { level: 2, name: emptyTitle })).toBeTruthy();
      expect(document.title).toBe(`${link} – Kalzit`);
    }
  });

  it("hides administration from viewers and explains it on direct access", async () => {
    await openShell("/admin", {
      ...TEST_USER,
      isServerAdmin: false,
      orgs: [{ id: "o1", name: "Org", role: "viewer" }],
    });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByRole("link", { name: "Administration" })).toBeNull();
  });

  it.each([
    ["owner", true],
    ["admin", true],
    ["editor", false],
  ])("shows administration to a member with role %s: %s", async (role, shown) => {
    // On the admin page, whose body only appears once the permissions are known.
    await openShell("/admin", {
      ...TEST_USER,
      isServerAdmin: false,
      orgs: [{ id: "o1", name: "Org", role }],
    });
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    if (shown) {
      expect(await screen.findByRole("heading", { name: "Nothing to manage yet" })).toBeTruthy();
      expect(within(nav).getByRole("link", { name: "Administration" })).toBeTruthy();
    } else {
      expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
      expect(within(nav).queryByRole("link", { name: "Administration" })).toBeNull();
    }
  });

  it("hides administration from a custom role with users:read only, as editors have", async () => {
    await openShell(
      "/admin",
      { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "sharer" }] },
      { sharer: ["users:read", "dashboards:share"] },
    );
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByRole("link", { name: "Administration" })).toBeNull();
  });

  it.each(["users:write", "settings:read", "roles:write", "audit:read"])(
    "shows administration for a custom role with %s",
    async (permission) => {
      await openShell(
        "/admin",
        { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "steward" }] },
        { steward: [permission] },
      );
      const nav = screen.getByRole("navigation", { name: "Main navigation" });
      expect(await within(nav).findByRole("link", { name: "Administration" })).toBeTruthy();
      expect(await screen.findByRole("heading", { name: "Nothing to manage yet" })).toBeTruthy();
    },
  );

  it("shows administration to a server admin who belongs to no organization", async () => {
    await openShell("/", { ...TEST_USER, isServerAdmin: true, orgs: [] });
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Administration" })).toBeTruthy();
  });

  it("asks for the current organization, the first membership", async () => {
    const { server } = await openShell("/", {
      ...TEST_USER,
      orgs: [
        { id: "first", name: "First", role: "viewer" },
        { id: "second", name: "Second", role: "owner" },
      ],
    });
    await waitFor(() => expect(server.calls.map((call) => call.path)).toContain("/api/orgs/first"));
    expect(server.calls.map((call) => call.path)).not.toContain("/api/orgs/second");
  });

  it("moves focus to the content with the skip link", async () => {
    const { user } = await openShell();
    await user.click(screen.getByRole("button", { name: "Skip to content" }));
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("switches between navigation and content with F6", async () => {
    const { user } = await openShell("/dashboards");
    await user.keyboard("{F6}");
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(document.activeElement).toBe(within(nav).getByRole("link", { name: "Dashboards" }));
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("user menu", () => {
  it("opens from the keyboard, moves with arrows and returns focus on Escape", async () => {
    const { user, menuButton } = await openShell();
    menuButton.focus();
    await user.keyboard("{Enter}");

    const menu = screen.getByRole("menu", { name: "Account" });
    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'));
    expect(items).toHaveLength(7);
    expect(document.activeElement).toBe(items[0]);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(items.at(-1));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Sign out" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it("opens on the last item with ArrowUp", async () => {
    const { user, menuButton } = await openShell();
    menuButton.focus();
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Sign out" }));
  });

  it("closes when clicking elsewhere without stealing focus back", async () => {
    const { user, menuButton } = await openShell();
    await user.click(menuButton);
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(screen.getByRole("heading", { level: 1 }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(menuButton);
  });

  it("applies and remembers the theme", async () => {
    const { user, menuButton } = await openShell();
    await user.click(menuButton);
    const dark = screen.getByRole("menuitemradio", { name: "Dark" });
    expect(dark.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(dark);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.activeElement).toBe(menuButton);
    await user.click(menuButton);
    expect(screen.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("switches the language everywhere and remembers it", async () => {
    const { user, menuButton } = await openShell();
    await user.click(menuButton);
    await user.click(screen.getByRole("menuitemradio", { name: "Deutsch" }));

    expect(await screen.findByRole("navigation", { name: "Hauptnavigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Datenquellen" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("de");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("de");
  });

  it("signs out and shows the sign-in page", async () => {
    const { user, menuButton, location } = await openShell("/dashboards");
    await user.click(menuButton);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(location().pathname).toBe("/login");
  });

  it("shows who is signed in at the top of the menu", async () => {
    const { user, menuButton } = await openShell();
    await user.click(menuButton);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(within(menu).getByText(TEST_USER.name)).toBeTruthy();
    expect(within(menu).getByText(TEST_USER.email)).toBeTruthy();
  });

  it("reports a failed sign-out next to the menu and clears it on the next attempt", async () => {
    const { user, menuButton, server } = await openShell();
    server.failNext("/api/auth/logout", 500, "internal");
    await user.click(menuButton);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    const message = await screen.findByText(/Something went wrong on the server/);
    const alert = message.closest('[role="alert"]');
    expect(alert).toBeTruthy();
    // Outside the anchor that holds the button, so it cannot push the button onto a new row.
    expect(alert?.closest(".menu-anchor")).toBeNull();

    await user.click(menuButton);
    expect(screen.queryByText(/Something went wrong on the server/)).toBeNull();
  });
});
