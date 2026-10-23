import type { Page } from "@playwright/test";
import { SQL } from "./api";
import { type Language, t } from "./i18n";
import { expect, type World } from "./test";
import { fillQuery } from "./ui";

/** A main page, or a state of one (a result, a dialog), for the layout and accessibility checks. */
export interface MainPage {
  name: string;
  path: (world: World) => string;
  /** Brings the page into the state to check and waits until it shows its content. */
  ready: (page: Page, world: World, language: Language) => Promise<void>;
}

const heading =
  (key: string, params: Record<string, string> = {}) =>
  async (page: Page, _world: World, language: Language) => {
    await expect(
      page.getByRole("heading", { name: t(key, params, language), exact: true }).first(),
    ).toBeVisible();
  };

const dialog = (page: Page, key: string, language: Language) =>
  expect(page.getByRole("dialog", { name: t(key, {}, language) })).toBeVisible();

async function dashboardReady(page: Page, world: World): Promise<void> {
  await expect(page.getByRole("heading", { name: world.dashboardTitle })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
}

export const MAIN_PAGES: readonly MainPage[] = [
  { name: "home", path: () => "/", ready: heading("home.welcome", { name: "Olga Owner" }) },
  { name: "dashboards", path: () => "/dashboards", ready: heading("dashboards.title") },
  { name: "dashboard", path: (w) => `/dashboards/${w.dashboardId}`, ready: dashboardReady },
  {
    name: "panel editor",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await dashboardReady(page, world);
      await page.getByRole("button", { name: t("dashboards.edit", {}, language) }).click();
      await page
        .getByRole("button", {
          name: t("dashboards.panel.editNamed", { title: "Sales" }, language),
        })
        .click();
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
      await page.getByRole("button", { name: t("dashboards.edit", {}, language) }).click();
      await page.getByRole("button", { name: t("dashboards.settings", {}, language) }).click();
      await dialog(page, "dashboards.settings.title", language);
      await expect(page.getByRole("dialog").locator(".cm-editor")).toBeVisible();
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
    ready: heading("datasources.edit.title"),
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
    path: () => "/admin/settings",
    ready: heading("admin.orgSettings.title"),
  },
  { name: "audit log", path: () => "/admin/audit", ready: heading("admin.audit.title") },
  { name: "users", path: () => "/admin/server/users", ready: heading("admin.users.title") },
  {
    name: "organizations",
    path: () => "/admin/server/organizations",
    ready: heading("admin.orgs.title"),
  },
  {
    name: "server settings",
    path: () => "/admin/server/settings",
    ready: heading("admin.serverSettings.title"),
  },
  { name: "account", path: () => "/account", ready: heading("admin.account.title") },
];
