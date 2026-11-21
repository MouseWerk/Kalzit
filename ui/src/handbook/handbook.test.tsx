import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../app/router";
import { openAdmin } from "../features/admin/test/openAdmin";
import type { FakeServer } from "../test/fakeServer";
import { HANDBOOK_PAGES } from "./catalog";
import { pageBySlug, resolveAnchor, resolveLink } from "./content";
import { type Block, type Inline, parseBlocks } from "./markdown";

/**
 * The built-in handbook (docs/design/blueprint/Handbook.dc.html, PR 1 of decision 9): the page,
 * its language, the search in the browser, links into the app and the switch.
 */

const UI = resolve(import.meta.dirname, "../..");
const DOCS = resolve(UI, "../docs");

/** Serves the bundle's handbook files (Markdown, search index) from disk, as the server would. */
function serveHandbookFiles(server: FakeServer): void {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = String(input).split("?")[0] ?? "";
    if (/\.md$|handbook-search-\w+\.json$/.test(address)) {
      server.calls.push({ method: "GET", path: address, body: undefined });
      const file = address.startsWith("/@fs/")
        ? decodeURIComponent(address.slice("/@fs/".length))
        : resolve(UI, `.${decodeURIComponent(address)}`);
      const response = new Response(readFileSync(file, "utf8"), { status: 200 });
      // The answer comes from this origin, as the app's own files do.
      Object.defineProperty(response, "url", { value: new URL(address, location.href).href });
      return response;
    }
    return inner(input, init);
  });
}

async function openHandbook(path: string, options: Parameters<typeof openAdmin>[1] = {}) {
  return openAdmin(path, {
    ...options,
    setupServer: (server) => {
      serveHandbookFiles(server);
      options.setupServer?.(server);
    },
  });
}

describe("the handbook page", () => {
  it("shows a page with contents, sections, previous and next, in the app's frame", async () => {
    const { server } = await openHandbook("/handbook/explore");
    expect(await screen.findByRole("heading", { level: 1, name: "Explore" })).toBeTruthy();
    const contents = screen.getByRole("navigation", { name: "Handbook contents" });
    const current = within(contents).getByRole("link", { name: "Explore" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(within(contents).getByText("Working with data")).toBeTruthy();
    const onThisPage = screen.getByRole("navigation", { name: "On this page" });
    expect(within(onThisPage).getByRole("link", { name: "Start from zero" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Next\s*Saved analyses/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Previous\s*Panels/ })).toBeTruthy();
    expect(screen.getAllByText(/^Handbook for Kalzit \d/).length).toBeGreaterThan(0);
    await waitFor(() => expect(document.title).toBe("Explore · Handbook · Kalzit"));
    // The page came from the bundle; nothing about the handbook asked the API.
    expect(server.calls.some((call) => call.path.startsWith("/api/handbook"))).toBe(false);
  });

  it("draws callouts, code with its language and Copy, tables in a frame of their own", async () => {
    await openHandbook("/handbook/backup");
    await screen.findByRole("heading", { level: 1, name: "Backup and restore" });
    expect(screen.getAllByRole("figure", { name: /^Code: Shell$/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBeGreaterThan(0);
    const sections = screen.getAllByRole("link", { name: "Link to this section" });
    expect(sections[0]?.getAttribute("href")).toBe("#scheduled-backups");
    await openHandbook("/handbook/data-sources");
    await screen.findByRole("heading", { level: 1, name: "Data sources" });
    expect(screen.getAllByRole("region", { name: /^Table: / }).length).toBeGreaterThan(0);
  });

  it("turns app: links into a button for who may open the screen, else names the place", async () => {
    const admin = await openHandbook("/handbook/backup", { isServerAdmin: true });
    const button = await screen.findByRole("link", { name: "Open Administration > Backups" });
    expect(button.getAttribute("href")).toBe("/settings/backups");
    await admin.user.click(button);
    await waitFor(() => expect(admin.location().pathname).toBe("/settings/backups"));

    await openHandbook("/handbook/backup", { isServerAdmin: false, permissions: [] });
    await screen.findByRole("heading", { level: 1, name: "Backup and restore" });
    expect(screen.queryByRole("link", { name: "Open Administration > Backups" })).toBeNull();
    expect(screen.getByText("Administration > Backups")).toBeTruthy();
    expect(screen.getByText(/Opens for people with the permission for it/)).toBeTruthy();
  });

  it("says when a linked section or a page is not there", async () => {
    await openHandbook("/handbook/explore#no-such-section");
    expect(
      await screen.findByText(/The linked section does not exist in this version/),
    ).toBeTruthy();
    await openHandbook("/handbook/no-such-page");
    expect(
      await screen.findByRole("heading", { level: 1, name: "This page is not in the handbook" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the overview" })).toBeTruthy();
  });

  it("says the tab is older than the server when a page cannot be fetched", async () => {
    // A page no other test opens (pages are fetched once per tab). No files served: the fetch
    // fails as after an update of the server.
    await openAdmin("/handbook/sdk-go", {});
    expect(await screen.findByRole("heading", { name: "Kalzit was updated" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("searches both languages in the browser, the interface's first", async () => {
    const { user, server, location } = await openHandbook("/handbook/overview");
    await screen.findByRole("heading", { level: 1, name: "Kalzit user guide" });
    const field = screen.getByRole("combobox", { name: "Search the handbook" });
    await user.click(field);
    // Before the first letter: three fixed ways in.
    expect(await screen.findByRole("option", { name: /Getting started/ })).toBeTruthy();
    await user.type(field, "Sicherungsziel");
    const list = await screen.findByRole("listbox", { name: "Search results" });
    await within(list).findByText(/hits? in German/);
    expect(within(list).getAllByText("DE").length).toBeGreaterThan(0);
    // The words never left the browser: only the two index files were fetched.
    expect(server.calls.filter((call) => call.path.includes("Sicherungsziel"))).toEqual([]);
    expect(server.calls.filter((call) => call.path.includes("handbook-search")).length).toBe(2);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(location().pathname).toMatch(/^\/handbook\//));
    expect(location().search).toEqual({ lang: "de" });
    expect(await screen.findByText("You are reading the German version.")).toBeTruthy();
  });

  it("says when nothing is found and offers ways on", async () => {
    const { user } = await openHandbook("/handbook/overview");
    await screen.findByRole("heading", { level: 1, name: "Kalzit user guide" });
    await user.type(screen.getByRole("combobox", { name: "Search the handbook" }), "xylofonq");
    expect(
      await screen.findByText("Nothing found for “xylofonq”", { selector: "p:not([aria-live])" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the glossary" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Search Kalzit" })).toBeTruthy();
  });

  it("opens from the Help menu, which keeps GitHub as its one link outside", async () => {
    const { user, location } = await openHandbook("/");
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.queryByRole("menuitem", { name: "Documentation" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Kalzit on GitHub/ })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: /Handbook/ }));
    await waitFor(() => expect(location().pathname).toBe("/handbook/overview"));
  });

  it("is gone from the Help menu and the screens when an admin turns it off", async () => {
    const { user } = await openHandbook("/admin/provisioning", {
      setupServer: (server) => {
        server.state.branding.handbook = false;
      },
    });
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.queryByRole("menuitem", { name: /Handbook/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Keyboard shortcuts/ })).toBeTruthy();
    await user.keyboard("{Escape}");
    // A link into the handbook leads to the page on GitHub instead.
    const guide = await screen.findByRole("link", {
      name: /In the handbook: Provisioning as code/,
    });
    expect(guide.getAttribute("href")).toMatch(
      /^https:\/\/github\.com\/MouseWerk\/Kalzit\/blob\/v[^/]+\/docs\/guide\/provisioning\.md$/,
    );
    expect(guide.getAttribute("target")).toBe("_blank");

    await openHandbook("/handbook/explore", {
      setupServer: (server) => {
        server.state.branding.handbook = false;
      },
    });
    expect(await screen.findByRole("heading", { name: "The handbook is turned off" })).toBeTruthy();
  });

  it("keeps the links of the screens inside the app", async () => {
    await openHandbook("/admin/provisioning");
    const guide = await screen.findByRole("link", {
      name: /In the handbook: Provisioning as code/,
    });
    expect(guide.getAttribute("href")).toBe("/handbook/provisioning");
    expect(guide.getAttribute("target")).toBeNull();
  });
});

describe("the handbook's links and languages", () => {
  const appLinks = (): string[] => {
    const found: string[] = [];
    const inline = (nodes: readonly Inline[]) => {
      for (const node of nodes) {
        if (node.type === "link" && node.href.startsWith("app:")) found.push(node.href);
        if ("children" in node) inline(node.children);
      }
    };
    const walk = (blocks: readonly Block[]) => {
      for (const block of blocks) {
        if (block.type === "paragraph" || block.type === "heading") inline(block.content);
        if (block.type === "list") for (const item of block.items) walk(item);
        if (block.type === "quote") walk(block.children);
        if (block.type === "table")
          for (const row of [block.head, ...block.rows]) row.forEach(inline);
      }
    };
    for (const page of HANDBOOK_PAGES) {
      for (const file of [page.en, page.de]) {
        if (file !== undefined) walk(parseBlocks(readFileSync(resolve(DOCS, file), "utf8")));
      }
    }
    return [...new Set(found)];
  };

  it("leads every app: link of the guide to a screen the app has", () => {
    const links = appLinks();
    expect(links.length).toBeGreaterThan(2);
    const router = createAppRouter(new QueryClient(), createMemoryHistory());
    for (const href of links) {
      const target = resolveLink("guide/backup.md", href);
      expect(target?.kind, href).toBe("app");
      const path = target?.kind === "app" ? target.path : "";
      const matches = router.matchRoutes(path.split(/[?#]/)[0] ?? "", {});
      const leaf = matches.at(-1);
      // A real screen: not the catch-all of not found.
      expect(leaf?.routeId, href).toBeDefined();
      expect(leaf?.routeId === "__root__" || leaf?.routeId?.endsWith("/$"), href).toBe(false);
      expect(leaf?.routeId?.startsWith("/_app"), href).toBe(true);
    }
  });

  it("finds a section in the other language at the same place", () => {
    const explore = pageBySlug("explore");
    expect(explore?.de).not.toBeNull();
    if (explore === undefined || explore.de === null) return;
    const anchor = explore.en.headings[1]?.id ?? "";
    const german = resolveAnchor(explore, explore.de, anchor);
    expect(german).toBe(explore.de.headings[1]?.id);
    expect(resolveAnchor(explore, explore.de, "no-such-section")).toBeUndefined();
  });

  it("keeps links between pages in the handbook and sends the rest to GitHub as of this release", () => {
    expect(resolveLink("guide/de/explore.md", "query-languages.md#neo4j-und-memgraph")).toEqual({
      kind: "page",
      slug: "query-languages",
      anchor: "neo4j-und-memgraph",
    });
    expect(resolveLink("guide/explore.md", "../operations/updates.md")).toEqual({
      kind: "page",
      slug: "updates",
      anchor: "",
    });
    expect(resolveLink("guide/explore.md", "../glossary.md")).toMatchObject({ slug: "glossary" });
    const api = resolveLink("guide/explore.md", "../api/datasources.md");
    expect(api).toMatchObject({ kind: "external" });
    expect(api?.kind === "external" && api.href).toMatch(
      /^https:\/\/github\.com\/MouseWerk\/Kalzit\/blob\/v[^/]+\/docs\/api\/datasources\.md$/,
    );
    expect(resolveLink("guide/explore.md", "javascript:alert(1)")).toBeNull();
    expect(resolveLink("guide/explore.md", "app://evil.example")).toBeNull();
  });
});
