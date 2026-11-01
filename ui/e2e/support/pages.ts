import type { Page } from "@playwright/test";
import { SQL } from "./api";
import { type Language, t } from "./i18n";
import { aiInUse, installedPlugin, loadedCatalog, MOCK_PLUGIN } from "./mocks";
import { expect, type World } from "./test";
import { fillQuery, panelAction, startEditing, toolbarButton } from "./ui";

/** A main page, or a state of one (a result, a dialog), for the layout and accessibility checks. */
export interface MainPage {
  name: string;
  path: (world: World) => string;
  /** Prepares the page before it opens, such as server answers a fresh server cannot give. */
  prepare?: (page: Page) => Promise<void>;
  /** Brings the page into the state to check and waits until it shows its content. */
  ready: (page: Page, world: World, language: Language) => Promise<void>;
}

/** Opens a main page and brings it into the state to check. */
export async function openMainPage(
  page: Page,
  main: MainPage,
  world: World,
  language: Language,
): Promise<void> {
  await main.prepare?.(page);
  await page.goto(main.path(world));
  await main.ready(page, world, language);
}

const heading =
  (key: string, params: Record<string, string> = {}) =>
  async (page: Page, _world: World, language: Language) => {
    await expect(
      page.getByRole("heading", { name: t(key, params, language), exact: true }).first(),
    ).toBeVisible();
  };

/** A settings section with its rows loaded. */
async function settingsRows(page: Page): Promise<void> {
  await expect(page.locator("#settings-section-title")).toBeVisible();
  await expect(page.locator(".settings-row").first()).toBeVisible();
}

/** A settings section that shows a heading of its own once its content arrived. */
const sectionWith =
  (key: string, params: Record<string, string> = {}) =>
  async (page: Page, world: World, language: Language) => {
    await expect(page.locator("#settings-section-title")).toBeVisible();
    await heading(key, params)(page, world, language);
  };

/** The plugins section with its tabs. */
async function pluginTabs(page: Page, language: Language): Promise<void> {
  await expect(page.locator("#settings-section-title")).toBeVisible();
  await expect(page.getByRole("tablist", { name: t("plugins.tabs", {}, language) })).toBeVisible();
}

const dialog = (page: Page, key: string, language: Language) =>
  expect(page.getByRole("dialog", { name: t(key, {}, language) })).toBeVisible();

async function dashboardReady(page: Page, world: World): Promise<void> {
  await expect(page.getByRole("heading", { name: world.dashboardTitle })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
}

export const MAIN_PAGES: readonly MainPage[] = [
  { name: "home", path: () => "/", ready: heading("home.welcome", { name: "Olga Owner" }) },
  { name: "dashboards", path: () => "/dashboards", ready: heading("dashboards.title") },
  { name: "saved analyses", path: () => "/explore/saved", ready: heading("analyses.list.title") },
  { name: "dashboard", path: (w) => `/dashboards/${w.dashboardId}`, ready: dashboardReady },
  {
    name: "panel editor",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await dashboardReady(page, world);
      await startEditing(page, language);
      await panelAction(page, "Sales", "dashboards.panel.editNamed", language);
      // A page of its own, at its own address.
      const editor = page.getByRole("region", {
        name: t("dashboards.editor.title", {}, language),
      });
      await expect(editor.locator(".cm-editor")).toBeVisible();
      await expect(page).toHaveURL(/\/panels\/p1\/edit$/);
    },
  },
  {
    name: "dashboard settings",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await dashboardReady(page, world);
      await startEditing(page, language);
      await toolbarButton(page, "dashboards.settings", language);
      await heading("dashboards.settings.title")(page, world, language);
      await expect(
        page.getByLabel(t("dashboards.settings.dashboardTitle", {}, language)),
      ).toBeVisible();
    },
  },
  {
    name: "dashboard time picker",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await dashboardReady(page, world);
      await page
        .getByRole("button", {
          name: t(
            "dashboards.time.buttonLabel",
            { range: t("dashboards.time.last6h", {}, language) },
            language,
          ),
        })
        .click();
      await dialog(page, "dashboards.time.title", language);
      await page
        .getByRole("button", { name: t("toolbar.calendar.pickStart", {}, language) })
        .click();
      await expect(page.locator(".calendar")).toBeVisible();
    },
  },
  {
    name: "dashboard menu",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await dashboardReady(page, world);
      await page
        .getByRole("button", { name: t("toolbar.more", {}, language), exact: true })
        .click();
      await expect(page.getByRole("menu", { name: t("toolbar.more", {}, language) })).toBeVisible();
    },
  },
  {
    name: "dashboard history",
    path: (w) => `/dashboards/${w.dashboardId}/versions`,
    ready: heading("dashboards.history.title"),
  },
  {
    name: "dashboard trash",
    path: () => "/dashboards/trash",
    ready: heading("dashboards.trash.title"),
  },
  { name: "playlists", path: () => "/dashboards/playlists", ready: heading("playlists.title") },
  {
    name: "library panels",
    path: () => "/dashboards/library",
    ready: heading("libraryPanels.title"),
  },
  {
    name: "analyses trash",
    path: () => "/explore/saved/trash",
    ready: heading("analyses.trash.title"),
  },
  // Fragen: AI in use, as the server answers once a provider is set up and AI is on.
  {
    name: "ask",
    path: () => "/ask",
    prepare: aiInUse,
    ready: async (page, world, language) => {
      await heading("ai.chat.empty.title")(page, world, language);
      await expect(page.getByLabel(t("ai.chat.question", {}, language))).toBeVisible();
    },
  },
  {
    name: "chat history",
    path: () => "/ask/history",
    prepare: aiInUse,
    ready: heading("ai.chat.history"),
  },
  { name: "explore", path: () => "/explore", ready: heading("explore.title") },
  {
    name: "explore result",
    path: () => "/explore",
    ready: async (page, world, language) => {
      await page
        .getByLabel(t("explore.datasource", {}, language))
        .selectOption({ label: world.sourceName });
      await fillQuery(page, SQL.series);
      await page.getByRole("button", { name: t("explore.run", {}, language) }).click();
      await expect(
        page.getByRole("region", { name: t("explore.result", {}, language) }).locator(".ts__plot"),
      ).toBeVisible();
    },
  },
  { name: "data sources", path: () => "/data-sources", ready: heading("datasources.title") },
  {
    name: "data source kinds",
    path: () => "/data-sources/new",
    ready: heading("datasources.new.pickKind"),
  },
  {
    name: "data source",
    path: (w) => `/data-sources/${w.sourceId}`,
    ready: async (page, world) => {
      await expect(
        page.getByRole("heading", { level: 1, name: world.sourceName, exact: true }),
      ).toBeVisible();
    },
  },
  { name: "members", path: () => "/admin/members", ready: heading("admin.members.title") },
  {
    name: "add member",
    path: () => "/admin/members",
    ready: async (page, _world, language) => {
      await page.getByRole("button", { name: t("admin.members.add", {}, language) }).click();
      await dialog(page, "admin.members.addTitle", language);
    },
  },
  { name: "teams", path: () => "/admin/teams", ready: heading("admin.teams.title") },
  { name: "roles", path: () => "/admin/roles", ready: heading("admin.roles.title") },
  {
    name: "organization settings",
    path: () => "/settings/organization",
    ready: settingsRows,
  },
  {
    name: "service accounts",
    path: () => "/admin/service-accounts",
    ready: heading("admin.serviceAccounts.title"),
  },
  { name: "audit log", path: () => "/admin/audit", ready: heading("admin.audit.title") },
  {
    name: "server audit log",
    path: () => "/admin/server/audit",
    ready: heading("admin.serverAudit.title"),
  },
  {
    name: "instances",
    path: () => "/admin/server/instances",
    ready: heading("admin.instances.title"),
  },
  {
    name: "plugins",
    path: () => "/settings/plugins",
    ready: (page, _world, language) => pluginTabs(page, language),
  },
  // The catalog once a signed index loaded, which needs HTTPS the run cannot give.
  {
    name: "plugin catalog",
    path: () => "/settings/plugins#catalog",
    prepare: loadedCatalog,
    ready: async (page, _world, language) => {
      await pluginTabs(page, language);
      await expect(page.getByText("Redfish BMC").first()).toBeVisible();
    },
  },
  {
    name: "plugin trust",
    path: () => "/settings/plugins#trust",
    ready: sectionWith("plugins.trust.keys.title"),
  },
  {
    name: "plugin page",
    path: () => `/settings/plugins/${MOCK_PLUGIN.id}`,
    prepare: installedPlugin,
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { level: 2, name: MOCK_PLUGIN.name, exact: true }),
      ).toBeVisible();
    },
  },
  {
    name: "AI administration",
    path: () => "/settings/ai",
    ready: sectionWith("ai.admin.providers.title"),
  },
  {
    name: "organization AI",
    path: () => "/settings/org-ai",
    ready: sectionWith("ai.admin.providers.title"),
  },
  {
    name: "organization plugins",
    path: () => "/settings/org-plugins",
    ready: sectionWith("plugins.org.title"),
  },
  { name: "general settings", path: () => "/settings/general", ready: settingsRows },
  { name: "network settings", path: () => "/settings/network", ready: settingsRows },
  { name: "security settings", path: () => "/settings/security", ready: settingsRows },
  { name: "sign-in settings", path: () => "/settings/signin", ready: settingsRows },
  { name: "storage settings", path: () => "/settings/storage", ready: settingsRows },
  // The usage page once its counts and the unused dashboards arrived.
  {
    name: "usage",
    path: () => "/admin/usage",
    ready: async (page, world, language) => {
      await heading("usage.dashboards.title")(page, world, language);
      await heading("usage.unused.title")(page, world, language);
      await expect(page.locator(".usage-tiles")).toBeVisible();
    },
  },
  { name: "users", path: () => "/admin/server/users", ready: heading("admin.users.title") },
  {
    name: "updates",
    path: () => "/admin/server/updates",
    ready: async (page, _world, language) => {
      await heading("admin.updates.title")(page, _world, language);
      await expect(
        page.getByRole("region", { name: t("admin.updates.history.title", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "organizations",
    path: () => "/admin/server/organizations",
    ready: heading("admin.orgs.title"),
  },
  {
    name: "server settings",
    path: () => "/settings/appearance",
    ready: settingsRows,
  },
  {
    name: "settings search",
    path: () => "/settings/datasources",
    ready: async (page, _world, language) => {
      await settingsRows(page);
      await page
        .getByRole("combobox", { name: t("settings.search.label", {}, language) })
        .fill("sqlite");
      await expect(page.getByRole("option").first()).toBeVisible();
    },
  },
  { name: "settings transfer", path: () => "/settings/transfer", ready: settingsRows },
  {
    name: "account",
    path: () => "/settings/profile",
    ready: heading("settings.section.profile.label"),
  },
];
