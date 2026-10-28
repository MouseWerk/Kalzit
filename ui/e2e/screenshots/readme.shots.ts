import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { Api, baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { BINARY, writePackage } from "../support/plugin";
import { boltTarget, GRAPH_FIXTURE, MONGO_FIXTURE } from "../support/services";
import { addPanel, fillQuery, panelAction, startEditing } from "../support/ui";
import { DEMO_OWNER, type Demo, GALLERY_TITLE, SCREENSHOT_NOW, seedDemo } from "./demo";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "screenshots",
);

let demo: Demo;

// One seeded server for all pictures: a failure stops the run instead of seeding again.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  demo = await seedDemo(process.env.KALZIT_E2E_SETUP_TOKEN ?? "");
});

test.afterAll(async () => {
  await demo.owner.dispose();
});

/** A page whose clock stands at the screenshot moment, so relative times and ranges repeat. */
async function openPage(
  browser: Browser,
  colorScheme: "light" | "dark" = "light",
  viewport = { width: 1440, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  // Date.now stands still at that moment; timers keep running, so the app works as usual.
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  // The server stamps sessions, memberships and saves with the real time of the run; the
  // pictures show them at the screenshot moment instead.
  for (const pattern of [
    /\/api\/me\/sessions(\?|$)/,
    /\/api\/orgs\/[^/]+\/(members|dashboards|audit|analyses)(\?|$)/,
    // One saved analysis (not its runs, versions or uses).
    /\/api\/orgs\/[^/]+\/analyses\/[^/?]+(\?|$)/,
  ]) {
    await context.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: atScreenshotTime(body, Date.now()) });
    });
  }
  return page;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Moves every timestamp in an API answer (Unix ms, as the API writes times) to the screenshot
 * moment, keeping whole days apart: "signed in now, expires in 30 days" stays so.
 */
function atScreenshotTime(value: unknown, realNow: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => atScreenshotTime(item, realNow));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, atScreenshotTime(item, realNow)]),
    );
  }
  const isTimestamp =
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value - realNow) < 400 * DAY_MS;
  return isTimestamp ? SCREENSHOT_NOW + Math.round((value - realNow) / DAY_MS) * DAY_MS : value;
}

async function signIn(
  page: Page,
  account: { email: string; password: string } = DEMO_OWNER,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("access.login.email")).fill(account.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(account.password);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
}

async function shoot(page: Page, name: string): Promise<void> {
  // Let requests, fonts and charts settle; no spinner or focus ring in the picture.
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  if ((await nav.count()) > 0) {
    // Explore appears once the data source list has loaded; the owner sees all five entries.
    // A viewer has the saved analyses there instead.
    const entry = new RegExp(`^(${t("explore.nav")}|${t("analyses.navReaders")})$`);
    await expect(nav.getByRole("link", { name: entry }).first()).toBeVisible();
  }
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

async function dashboardReady(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: demo.dashboardTitle })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales in the selected region" })).toBeVisible();
  await expect(page.locator(".stat")).toBeVisible();
  // uPlot, not the SVG chart shown while it loads.
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("sign-in", async ({ browser }) => {
  const page = await openPage(browser);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: t("access.login.title") })).toBeVisible();
  await shoot(page, "sign-in");
  await page.context().close();
});

test("sign-in, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: t("access.login.title") })).toBeVisible();
  await shoot(page, "sign-in-dark");
  await page.context().close();
});

test("start page", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // The demo dashboard starred and opened once, so the favorites and the recent row show it.
  const dashboard = `/api/orgs/${demo.owner.orgId}/dashboards/${demo.dashboardId}`;
  expect((await page.request.put(`${dashboard}/star`)).ok()).toBe(true);
  expect((await page.request.post(`${dashboard}/views`)).ok()).toBe(true);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: t("home.welcome", { name: DEMO_OWNER.name }) }),
  ).toBeVisible();
  await expect(page.locator(".stat-tile__skeleton")).toHaveCount(0);
  await expect(page.locator(".dash-card")).toHaveCount(1);
  await expect(page.locator(".recent-card")).toHaveCount(1);
  await shoot(page, "start");
  await page.context().close();
});

test("dashboards", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/dashboards");
  await expect(page.getByRole("link", { name: demo.dashboardTitle })).toBeVisible();
  await shoot(page, "dashboards");
  await page.context().close();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`dashboard, ${colorScheme}`, async ({ browser }) => {
    const page = await openPage(browser, colorScheme);
    await signIn(page);
    await page.goto(`/dashboards/${demo.dashboardId}`);
    await dashboardReady(page);
    await shoot(page, `dashboard-${colorScheme}`);
    await page.context().close();
  });
}

test("time picker, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await page
    .getByRole("button", {
      name: t("dashboards.time.buttonLabel", { range: t("dashboards.time.last6h") }),
    })
    .click();
  const picker = page.getByRole("dialog", { name: t("dashboards.time.title") });
  await picker.getByRole("button", { name: t("toolbar.calendar.pickStart") }).click();
  await expect(picker.locator(".calendar")).toBeVisible();
  // The picture shows the picker as it opens, without the focus ring in its search field.
  await shoot(page, "time-picker-dark");
  await page.context().close();
});

test("dashboard in edit mode, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await startEditing(page);
  const rail = page.getByRole("complementary", { name: t("toolbar.rail") });
  await rail.getByRole("button", { name: t("toolbar.add"), exact: true }).click();
  await expect(rail.getByRole("region", { name: t("toolbar.add") })).toBeVisible();
  await shoot(page, "dashboard-edit-dark");
  await page.context().close();
});

test("dashboard, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await shoot(page, "dashboard-phone");
  await page.context().close();
});
for (const colorScheme of ["light", "dark"] as const) {
  test(`panel types, ${colorScheme}`, async ({ browser }) => {
    const page = await openPage(browser, colorScheme);
    await signIn(page);
    await page.goto(`/dashboards/${demo.galleryId}`);
    await expect(page.getByRole("heading", { name: GALLERY_TITLE })).toBeVisible();
    await expect(page.locator(".bar__rect")).toHaveCount(12);
    await expect(page.locator(".bargauge__fill")).toHaveCount(4);
    await expect(page.locator(".pie__slice")).toHaveCount(4);
    await expect(page.locator(".text-panel a")).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shoot(page, `dashboard-panels-${colorScheme}`);
    await page.context().close();
  });
}

/** The full-page panel editor on the demo's time series, its chart drawn. */
async function panelEditor(page: Page): Promise<void> {
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await startEditing(page);
  await panelAction(page, "Sales in the selected region", "dashboards.panel.editNamed");
  const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
  await expect(editor.locator(".cm-content").first()).toBeVisible();
  await expect(editor.locator(".uplot")).toHaveCount(1);
  await expect(editor.locator('[aria-busy="true"]')).toHaveCount(0);
}

test("panel editor, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await panelEditor(page);
  await shoot(page, "panel-editor-dark");
  await page.context().close();
});

/** A new panel: the visualization picker open, the first query ready. */
async function newPanel(page: Page): Promise<void> {
  await page.goto(`/dashboards/${demo.dashboardId}`);
  await dashboardReady(page);
  await startEditing(page);
  await addPanel(page);
  const editor = page.getByRole("region", { name: t("dashboards.editor.newTitle") });
  await expect(editor.locator(".cm-content").first()).toBeVisible();
  await expect(editor.getByRole("radio").first()).toBeVisible();
}

test("new panel, dark", async ({ browser }) => {
  const page = await openPage(browser, "dark");
  await signIn(page);
  await newPanel(page);
  await shoot(page, "panel-new-dark");
  await page.context().close();
});

test("new panel, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await newPanel(page);
  await shoot(page, "panel-new-phone");
  await page.context().close();
});

test("panel editor, phone", async ({ browser }) => {
  const page = await openPage(browser, "light", { width: 360, height: 780 });
  await signIn(page);
  await panelEditor(page);
  await shoot(page, "panel-editor-phone");
  await page.context().close();
});

test("explore", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/explore");
  await page.getByLabel(t("explore.datasource")).selectOption({ label: demo.sourceName });
  await fillQuery(
    page,
    "SELECT ts AS time, amount FROM sales WHERE region = 'West' AND $__timeFilter(ts) ORDER BY ts",
  );
  // Closes the suggestion list; on the page (not in a dialog) Escape does nothing else.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-tooltip")).toHaveCount(0);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.locator(".uplot")).toBeVisible();
  await expect(result).toHaveAttribute("aria-busy", "false");
  await shoot(page, "explore");
  await page.context().close();
});

for (const scheme of ["light", "dark"] as const) {
  test(`data source kinds, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto("/data-sources/new");
    await expect(page.getByRole("link", { name: "PostgreSQL", exact: true })).toBeVisible();
    await shoot(page, `data-source-kinds-${scheme}`);
    await page.context().close();
  });
}

test("data source form", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // The form for a new PostgreSQL source, filled in but not sent: the demo's own SQLite source
  // would show this machine's run folder, and a connection test a time that differs per run.
  await page.goto("/data-sources/new?kind=postgres");
  await page.getByLabel(t("datasources.form.name"), { exact: true }).fill("Shop (PostgreSQL)");
  await page.getByLabel(t("datasources.settings.host")).fill("db.internal");
  await page.getByLabel(t("datasources.settings.database")).fill("shop");
  await page.getByLabel(t("datasources.settings.user")).fill("kalzit_reader");
  await shoot(page, "data-source");
  await page.context().close();
});

test("administration, members", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/admin/members");
  await expect(page.getByLabel(t("admin.members.roleOf", { name: "Paul Richter" }))).toBeVisible();
  await shoot(page, "admin-members");
  await page.context().close();
});

test("updates", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // One backup, so the list shows what it holds.
  expect((await page.request.post("/api/admin/updates/backups")).ok()).toBe(true);
  await page.goto("/admin/server/updates");
  const backups = page.getByRole("list", { name: t("admin.updates.backups.title") });
  await expect(backups.getByRole("listitem").first()).toBeVisible();
  await shoot(page, "updates");
  await page.context().close();
});

test("account", async ({ browser }) => {
  const page = await openPage(browser);
  await signIn(page);
  // Every picture signed in once; two sessions (this browser and one other) look like real use.
  expect((await page.request.post("/api/me/sessions/revoke-others")).ok()).toBe(true);
  const other = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  await page.goto("/settings/profile");
  await expect(
    page.getByRole("heading", { name: t("settings.section.profile.label") }),
  ).toBeVisible();
  const sessions = page.getByRole("list", { name: t("admin.account.sessions") });
  await expect(sessions).toBeVisible();
  // Scrolled so the sessions list is whole, not cut at the bottom edge.
  await page
    .getByRole("heading", { name: t("admin.account.sessions") })
    .evaluate((heading) => heading.scrollIntoView({ block: "start" }));
  await expect(sessions.getByRole("listitem")).toHaveCount(2);
  await shoot(page, "account");
  await other.dispose();
  await page.context().close();
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`settings, ${colorScheme}`, async ({ browser }) => {
    const page = await openPage(browser, colorScheme);
    await signIn(page);
    await page.goto("/settings/appearance");
    await expect(
      page.getByRole("heading", { name: t("settings.section.appearance.label") }),
    ).toBeVisible();
    await expect(page.locator(".settings-row").first()).toBeVisible();
    await shoot(page, `settings-${colorScheme}`);
    await page.context().close();
  });
}

for (const colorScheme of ["dark", "light"] as const) {
  test(`about, ${colorScheme}`, async ({ browser }) => {
    const page = await openPage(browser, colorScheme);
    // The crystal holds still (reduced motion), so a rerun gives the same picture.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(page);
    await page.goto("/settings/about");
    await expect(
      page.getByRole("heading", { name: t("settings.section.about.label") }),
    ).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "axum", exact: true })).toBeVisible();
    await shoot(page, `about-${colorScheme}`);
    await page.context().close();
  });
}

test("settings, phone", async ({ browser }) => {
  const page = await openPage(browser, "dark", { width: 360, height: 780 });
  await signIn(page);
  await page.goto("/settings/appearance");
  await expect(page.locator(".settings-row").first()).toBeVisible();
  await shoot(page, "settings-phone");
  await page.context().close();
});

/** Orders as a shop's document store keeps them: a nested customer and an array of items. */
const ORDERS = [
  [
    "A-1041",
    "Nord",
    "Hamburg",
    "paid",
    [
      ["Desk lamp", 2, 39.9],
      ["Cable set", 1, 12.5],
    ],
  ],
  ["A-1042", "Süd", "München", "shipped", [["Office chair", 1, 249]]],
  [
    "A-1043",
    "West",
    "Köln",
    "paid",
    [
      ["Monitor arm", 1, 89],
      ["Desk lamp", 1, 39.9],
    ],
  ],
  ["A-1044", "Ost", "Leipzig", "open", [["Notebook stand", 3, 29.5]]],
  [
    "A-1045",
    "Nord",
    "Bremen",
    "shipped",
    [
      ["Keyboard", 1, 79],
      ["Mouse", 1, 35],
    ],
  ],
  ["A-1046", "West", "Düsseldorf", "paid", [["Office chair", 2, 249]]],
] as const;

function writeOrders(path: string): void {
  const documents = ORDERS.map(([number, region, city, status, items], index) => ({
    number,
    status,
    createdAt: new Date(SCREENSHOT_NOW - (ORDERS.length - index) * 3_600_000).toISOString(),
    customer: { region, city, newsletter: index % 2 === 0 },
    items: items.map(([name, quantity, price]) => ({ name, quantity, price })),
    total:
      Math.round(items.reduce((sum, [, quantity, price]) => sum + quantity * price, 0) * 100) / 100,
  }));
  writeFileSync(path, JSON.stringify(documents, null, 2));
}

/**
 * A dashboard on a JSON file of orders: the documents as a tree, their schema and the
 * distribution of one field, the documents kept as documents. A dashboard rather than Explore,
 * since Explore would show the file's path in this machine's run folder.
 */
test("dashboard, documents", async ({ browser }) => {
  const files = process.env.KALZIT_E2E_FILES ?? "";
  expect(files).not.toBe("");
  const path = join(files, "orders.json");
  writeOrders(path);
  // A session of its own: the account picture signed out every other session, the demo's too.
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const created = await owner.context.post(`/api/orgs/${owner.orgId}/datasources`, {
    data: { name: "Orders (JSON)", kind: "file", settings: { path }, secrets: {} },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: sourceId } = (await created.json()) as { id: string };
  const target = [{ refId: "A", datasourceId: sourceId, query: {} }];
  const dashboardId = await owner.createDashboard({
    schemaVersion: 2,
    title: "Orders",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      {
        id: "orders",
        type: "documents",
        title: "Orders as documents",
        grid: { x: 0, y: 0, w: 14, h: 16 },
        targets: target,
        options: {},
      },
      {
        id: "schema",
        type: "schema",
        title: "Fields of the orders",
        grid: { x: 14, y: 0, w: 10, h: 9 },
        targets: target,
        options: {},
      },
      {
        id: "status",
        type: "distribution",
        title: "Order status",
        grid: { x: 14, y: 9, w: 10, h: 7 },
        targets: target,
        options: { path: "status" },
      },
    ],
  });
  await owner.dispose();

  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
  await expect(page.getByRole("tree").first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await shoot(page, "dashboard-documents-dark");
  await page.context().close();
});

test("panel editor, analysis steps", async ({ browser }) => {
  const sql =
    "SELECT ts AS time, amount FROM sales WHERE region = 'West' AND $__timeFilter(ts) ORDER BY ts";
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const dashboardId = await owner.createDashboard({
    // Version 2 reads `transformations` as analysis steps; version 1 would drop them.
    schemaVersion: 2,
    title: "Sales analysis",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      {
        id: "smooth",
        type: "timeseries",
        title: "Sales West with moving average and trend",
        grid: { x: 0, y: 0, w: 24, h: 10 },
        targets: [{ refId: "A", datasourceId: demo.sourceId, query: { sql } }],
        transformations: [
          {
            id: "avg",
            type: "movingAverage",
            frame: "A",
            field: "amount",
            window: 12,
            name: "moving average",
          },
          {
            id: "trend",
            type: "trend",
            frame: "A",
            field: "amount",
            output: "fitted",
            name: "trend",
          },
        ],
        options: { unit: "EUR" },
      },
    ],
  });
  await owner.dispose();
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${dashboardId}/panels/smooth/edit`);
  const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
  await expect(editor.locator(".uplot")).toHaveCount(1);
  await editor.getByRole("tab", { name: new RegExp(`^${t("analysis.steps.title")}`) }).click();
  await expect(editor.locator('[aria-busy="true"]')).toHaveCount(0);
  await shoot(page, "panel-editor-steps-dark");
  await page.context().close();
});

/** The four regions as columns of one frame, for the series that stack. */
const BY_REGION_COLUMNS = `SELECT ts AS time, ${["Nord", "Ost", "Süd", "West"]
  .map((region) => `SUM(CASE WHEN region = '${region}' THEN amount END) AS "${region}"`)
  .join(", ")} FROM sales WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts`;

/** One reading per hour, few enough points for steps to show. */
const HOURLY_WEST =
  "SELECT ts AS time, amount FROM sales WHERE region = 'West' AND strftime('%M', ts) = '00' AND $__timeFilter(ts) ORDER BY ts";

let graphStyles: string | undefined;

/** A dashboard with one panel per graph style, seeded after the other pictures. */
async function graphStylesDashboard(): Promise<string> {
  const sql = (query: string) => [
    { refId: "A", datasourceId: demo.sourceId, query: { sql: query } },
  ];
  const region = (name: string) =>
    `SELECT ts AS time, amount FROM sales WHERE region = '${name}' AND $__timeFilter(ts) ORDER BY ts`;
  const withPrevious =
    'SELECT ts AS time, amount AS "this hour", LAG(amount, 12) OVER (ORDER BY ts) AS "hour before" FROM sales WHERE region = \'West\' AND $__timeFilter(ts) ORDER BY ts';
  const panel = (
    id: string,
    title: string,
    grid: { x: number; y: number; w: number; h: number },
    query: string,
    fieldConfig: Record<string, unknown> = { defaults: {}, overrides: [] },
  ) => ({ id, type: "timeseries", title, grid, targets: sql(query), options: {}, fieldConfig });
  // The account picture signs out every other session, the seeding one included.
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const id = await owner.createDashboard({
    schemaVersion: 1,
    title: "Graph styles",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      panel(
        "mono",
        "One series: monochrome, smooth, hatched",
        { x: 0, y: 0, w: 12, h: 8 },
        region("Nord"),
      ),
      panel(
        "compare",
        "With a comparison series, dashed",
        { x: 12, y: 0, w: 12, h: 8 },
        withPrevious,
        {
          defaults: {},
          overrides: [
            { matcher: { type: "name", value: "hour before" }, properties: { comparison: true } },
          ],
        },
      ),
      panel("bars", "Bars", { x: 0, y: 8, w: 8, h: 7 }, region("Ost"), {
        defaults: { drawStyle: "bars", barWidth: 70 },
        overrides: [],
      }),
      panel("points", "Points", { x: 8, y: 8, w: 8, h: 7 }, region("Süd"), {
        defaults: { drawStyle: "points", pointSize: 4 },
        overrides: [],
      }),
      panel("steps", "Hourly, in steps, dotted", { x: 16, y: 8, w: 8, h: 7 }, HOURLY_WEST, {
        defaults: { lineInterpolation: "stepAfter", lineStyle: "dotted", fill: "none" },
        overrides: [],
      }),
      panel("stacked", "Four regions, stacked", { x: 0, y: 15, w: 8, h: 7 }, BY_REGION_COLUMNS, {
        defaults: { stack: "normal" },
        overrides: [],
      }),
      panel("percent", "Stacked to 100 %", { x: 8, y: 15, w: 8, h: 7 }, BY_REGION_COLUMNS, {
        defaults: { stack: "percent", fillOpacity: 70, lineWidth: 0 },
        overrides: [],
      }),
      panel(
        "palette",
        "Four regions, fading fill",
        { x: 16, y: 15, w: 8, h: 7 },
        BY_REGION_COLUMNS,
        {
          defaults: { fill: "solid", gradientMode: "opacity", fillOpacity: 35 },
          overrides: [],
        },
      ),
    ],
  });
  await owner.dispose();
  return id;
}

for (const scheme of ["light", "dark", "contrast"] as const) {
  test(`graph styles, ${scheme}`, async ({ browser }) => {
    // Tall enough for all three rows of panels.
    const page = await openPage(browser, scheme === "contrast" ? "dark" : scheme, {
      width: 1440,
      height: 1000,
    });
    await signIn(page);
    graphStyles ??= await graphStylesDashboard();
    await page.goto(`/dashboards/${graphStyles}`);
    await expect(page.getByRole("heading", { name: "Graph styles" })).toBeVisible();
    await expect(page.locator(".uplot")).toHaveCount(8);
    if (scheme === "contrast") {
      // The charts read the theme again when it changes, as on a switch in the account page.
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "contrast";
      });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "contrast");
    }
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shoot(page, `graph-styles-${scheme}`);
    await page.context().close();
  });
}

/** A saved analysis on the demo's sales source: a query, no steps, a visualization. */
function analysisModel(title: string, sql: string, type: string, description?: string) {
  return {
    schemaVersion: 1,
    title,
    ...(description === undefined ? {} : { description }),
    timeRange: { from: "now-6h", to: "now" },
    targets: [{ refId: "A", datasourceId: demo.sourceId, query: { sql } }],
    steps: [],
    visualization: { type, options: {} },
  };
}

let analyses: { west: string; regions: string } | undefined;

/** A few saved analyses by the owner and by Lea, seeded once for the pictures that show them. */
async function seedAnalyses(): Promise<{ west: string; regions: string }> {
  if (analyses !== undefined) return analyses;
  // The account picture signs out every other session, the seeding one included.
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const lea = await Api.signIn(demo.lea.email, demo.lea.password);
  try {
    const west = await owner.createAnalysis(
      analysisModel(
        "Sales West, last six hours",
        "SELECT ts AS time, amount FROM sales WHERE region = 'West' AND $__timeFilter(ts) ORDER BY ts",
        "timeseries",
        "For the weekly review of the western region.",
      ),
    );
    const regions = await owner.createAnalysis(
      analysisModel(
        "Total per region",
        "SELECT region, ROUND(SUM(amount)) AS total FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
        "table",
        "Sales summed per region over the chosen range.",
      ),
    );
    await lea.createAnalysis(
      analysisModel(
        "Average order per region",
        "SELECT region, ROUND(AVG(amount), 1) AS average FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
        "bar",
      ),
    );
    await lea.createAnalysis(
      analysisModel(
        "Highest readings North",
        "SELECT ts AS time, amount FROM sales WHERE region = 'Nord' AND $__timeFilter(ts) ORDER BY amount DESC LIMIT 20",
        "table",
      ),
    );
    analyses = { west, regions };
    return analyses;
  } finally {
    await owner.dispose();
    await lea.dispose();
  }
}

test("explore, saved analysis", async ({ browser }) => {
  const { west } = await seedAnalyses();
  const page = await openPage(browser);
  await signIn(page);
  await page.goto(`/explore?analysis=${west}`);
  await expect(page.getByRole("heading", { name: "Sales West, last six hours" })).toBeVisible();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.locator(".uplot")).toBeVisible();
  await expect(result).toHaveAttribute("aria-busy", "false");
  await shoot(page, "explore-saved");
  await page.context().close();
});

test("saved analyses", async ({ browser }) => {
  await seedAnalyses();
  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/explore/saved");
  await expect(page.getByRole("heading", { name: t("analyses.list.title") })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Average order per region", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Lea Hoffmann").first()).toBeVisible();
  await shoot(page, "analyses");
  await page.context().close();
});

test("saved analysis, read-only for a viewer", async ({ browser }) => {
  const { regions } = await seedAnalyses();
  const page = await openPage(browser);
  await signIn(page, demo.sofia);
  await page.goto(`/explore/saved/${regions}`);
  await expect(page.getByRole("heading", { name: "Total per region" })).toBeVisible();
  await expect(page.getByText(t("analyses.view.readOnly"))).toBeVisible();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByRole("table")).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await shoot(page, "analysis-view");
  await page.context().close();
});

test("dashboard, live, dark", async ({ browser }) => {
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const sql =
    "SELECT ts AS time, amount FROM sales WHERE region = 'Nord' AND $__timeFilter(ts) ORDER BY ts";
  const target = [{ refId: "A", datasourceId: demo.sourceId, query: { sql } }];
  const dashboardId = await owner.createDashboard({
    schemaVersion: 1,
    title: "Sales, live",
    // Live runs on the server, whose clock is not the pictures' fixed one: a fixed range around
    // the screenshot moment, where the fixture data lies.
    timeRange: {
      from: new Date(SCREENSHOT_NOW - 6 * 3_600_000).toISOString(),
      to: new Date(SCREENSHOT_NOW).toISOString(),
    },
    // The interval live runs the queries at: SQLite cannot report changes.
    refreshSeconds: 30,
    variables: [],
    panels: [
      {
        id: "trend",
        type: "timeseries",
        title: "Sales North",
        grid: { x: 0, y: 0, w: 16, h: 10 },
        targets: target,
        options: { unit: "EUR" },
      },
      {
        id: "latest",
        type: "stat",
        title: "Latest value",
        grid: { x: 16, y: 0, w: 8, h: 10 },
        targets: target,
        options: { unit: "EUR", reducer: "last" },
      },
    ],
  });
  await owner.dispose();
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto(`/dashboards/${dashboardId}`);
  await expect(page.getByRole("heading", { name: "Sales, live" })).toBeVisible();
  await page
    .getByRole("button", {
      name: t("toolbar.refresh.menuRunning", {
        interval: t("toolbar.refresh.everySeconds", { n: 30 }),
      }),
      exact: true,
    })
    .click();
  await page.getByRole("menuitemradio", { name: t("live.menu.live"), exact: true }).click();
  await expect(page.getByRole("button", { name: t("live.menu.label") })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Sales North", exact: true }).locator(".panel-card__live"),
  ).toContainText(t("live.every", { interval: "30s" }));
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await shoot(page, "dashboard-live-dark");
  await page.context().close();
});

/**
 * The field distribution of a MongoDB result in Explore, counted in the database. Needs the
 * MongoDB of the document spec (KALZIT_E2E_MONGODB, seeded with e2e/fixtures/mongo-orders.js);
 * without it this picture is skipped and the one in the repository stays.
 */
test("explore, field distribution, dark", async ({ browser }) => {
  const hosts = process.env.KALZIT_E2E_MONGODB ?? "";
  test.skip(hosts === "", "KALZIT_E2E_MONGODB is not set; the picture needs the MongoDB fixture");
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const name = "Shop orders (MongoDB)";
  await owner.createSource(
    name,
    "mongodb",
    { hosts, database: MONGO_FIXTURE.database, user: MONGO_FIXTURE.user },
    { password: MONGO_FIXTURE.password },
  );
  await owner.dispose();
  const page = await openPage(browser, "dark");
  await signIn(page);
  await page.goto("/explore");
  await page.getByLabel(t("explore.datasource")).selectOption({ label: name });
  await page
    .getByLabel(t("documents.pipeline.collection"), { exact: true })
    .fill(MONGO_FIXTURE.collection);
  await page.getByRole("button", { name: t("explore.run") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result).toContainText(
    t("documents.summary.countMany", { count: MONGO_FIXTURE.documents }),
  );
  await page.getByLabel(t("explore.visualization"), { exact: true }).selectOption("distribution");
  await page
    .getByLabel(t("documents.distribution.path"), { exact: true })
    .selectOption("customer.city");
  await expect(
    result.getByText(t("documents.distribution.scope.all", { count: MONGO_FIXTURE.documents }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await shoot(page, "explore-distribution-dark");
  await page.context().close();
});

let graphDashboards: { overview: string; detail: string } | undefined;

/**
 * The graph panels on the shop graph of the graph spec: a network, the category tree as a
 * hierarchy, a shortest path and a network in explorer mode, and the network and the explorer
 * again at full width for the node details and explorer pictures. Needs the Neo4j of the graph spec
 * (KALZIT_E2E_NEO4J, seeded with e2e/fixtures/graph-shop.cypher); without it these pictures are
 * skipped and the ones in the repository stay.
 */
async function seedGraphDashboards(address: string): Promise<{ overview: string; detail: string }> {
  if (graphDashboards !== undefined) return graphDashboards;
  // The account picture signs out every other session, the seeding one included.
  const owner = await Api.signIn(DEMO_OWNER.email, DEMO_OWNER.password);
  const datasourceId = await owner.createSource(
    "Shop graph (Neo4j)",
    "neo4j",
    { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
    { password: GRAPH_FIXTURE.neo4jPassword },
  );
  const panel = (
    id: string,
    type: string,
    title: string,
    grid: { x: number; y: number; w: number; h: number },
    cypher: string,
    options: Record<string, unknown> = {},
  ) => ({
    id,
    type,
    title,
    grid,
    targets: [{ refId: "A", datasourceId, query: { cypher } }],
    options,
  });
  const shop =
    "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[i:CONTAINS]->(pr:Product) RETURN c, p, o, i, pr";
  const ben = "MATCH (c:Customer {name: 'Ben'}) RETURN c";
  const overview = await owner.createDashboard({
    schemaVersion: 1,
    title: "Shop graph",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      panel(
        "shop",
        "network",
        "Customers, orders and products",
        { x: 0, y: 0, w: 12, h: 11 },
        shop,
      ),
      panel(
        "tree",
        "hierarchy",
        "Category tree",
        { x: 12, y: 0, w: 12, h: 11 },
        "MATCH (a:Category)-[r:SUBCATEGORY]->(b:Category) RETURN a, r, b",
      ),
      panel(
        "path",
        "path",
        "From Ana to the monitor arm",
        { x: 0, y: 11, w: 12, h: 8 },
        "MATCH p = shortestPath((c:Customer {name: 'Ana'})-[:PLACED|CONTAINS*..10]-(pr:Product {name: 'Monitor arm'})) RETURN p",
      ),
      panel("explorer", "network", "Around Ben", { x: 12, y: 11, w: 12, h: 8 }, ben, {
        explorer: true,
        expandLimit: 10,
      }),
    ],
  });
  const detail = await owner.createDashboard({
    schemaVersion: 1,
    title: "Shop graph in detail",
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      panel(
        "shop",
        "network",
        "Customers, orders and products",
        { x: 0, y: 0, w: 24, h: 14 },
        shop,
      ),
      panel("explorer", "network", "Around Ben", { x: 0, y: 14, w: 24, h: 16 }, ben, {
        explorer: true,
        expandLimit: 10,
      }),
    ],
  });
  await owner.dispose();
  graphDashboards = { overview, detail };
  return graphDashboards;
}

/** Loads Ben's neighbours in an explorer panel, from his row in the panel's table. */
async function exploreBen(around: Locator): Promise<void> {
  await around.getByRole("button", { name: t("graph.showTable"), exact: true }).click();
  // The explorer is on once the panel knows the source may be queried; a click loads.
  const steps = around.getByRole("region", { name: t("graph.steps.title"), exact: true });
  await expect(steps).toBeVisible();
  await around
    .getByRole("table", { name: /./ })
    .first()
    .getByRole("button", { name: "Ben", exact: true })
    .click();
  await expect(steps.getByRole("button", { name: /^Ben \+/ })).toBeVisible();
  await around.getByRole("button", { name: t("graph.showTable"), exact: true }).click();
  await expect(around.getByRole("application", { name: "Around Ben", exact: true })).toBeVisible();
}

for (const scheme of ["light", "dark"] as const) {
  test(`graph panels, ${scheme}`, async ({ browser }) => {
    const address = process.env.KALZIT_E2E_NEO4J ?? "";
    test.skip(address === "", "KALZIT_E2E_NEO4J is not set; the picture needs the Neo4j fixture");
    const { overview } = await seedGraphDashboards(address);
    const page = await openPage(browser, scheme, { width: 1440, height: 1000 });
    await signIn(page);
    await page.goto(`/dashboards/${overview}`);
    await expect(page.getByRole("heading", { name: "Shop graph" })).toBeVisible();
    await expect(page.getByRole("application")).toHaveCount(3);
    await expect(
      page.getByRole("heading", { name: t("graph.path.title", { number: 1, count: 6 }) }),
    ).toBeVisible();
    // Explorer mode: Ben's orders.
    await exploreBen(page.getByRole("article", { name: "Around Ben", exact: true }));
    // Network, hierarchy and explorer draw; the path panel lists its paths.
    await expect(page.getByRole("application")).toHaveCount(3);
    await expect(page.getByText(t("graph.layout.settling"))).toHaveCount(0);
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await shoot(page, `graph-panels-${scheme}`);
    if (scheme === "dark") {
      // Each panel on its own for the guide.
      for (const [title, name] of [
        ["Customers, orders and products", "graph-network-dark"],
        ["Category tree", "graph-hierarchy-dark"],
        ["From Ana to the monitor arm", "graph-path-dark"],
      ] as const) {
        await page
          .getByRole("article", { name: title, exact: true })
          .screenshot({ path: join(OUT, `${name}.png`), animations: "disabled", caret: "hide" });
      }
    }
    await page.context().close();
  });
}

test("graph node details and explorer, dark", async ({ browser }) => {
  const address = process.env.KALZIT_E2E_NEO4J ?? "";
  test.skip(address === "", "KALZIT_E2E_NEO4J is not set; the picture needs the Neo4j fixture");
  const { detail } = await seedGraphDashboards(address);
  const page = await openPage(browser, "dark", { width: 1440, height: 1000 });
  await signIn(page);
  await page.goto(`/dashboards/${detail}`);
  const title = "Customers, orders and products";
  const shop = page.getByRole("article", { name: title, exact: true });
  await expect(shop.getByRole("application", { name: title, exact: true })).toBeVisible();
  // Ana selected from the panel's table, then back to the drawing with her details open.
  const table = shop.getByRole("button", { name: t("graph.showTable"), exact: true });
  await table.click();
  await shop.getByRole("button", { name: "Ana", exact: true }).first().click();
  await table.click();
  await expect(
    shop.getByRole("region", { name: t("graph.details", { name: "Ana" }) }),
  ).toBeVisible();
  await expect(page.getByText(t("graph.layout.settling"))).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await shop.screenshot({
    path: join(OUT, "graph-inspector-dark.png"),
    animations: "disabled",
    caret: "hide",
  });
  const around = page.getByRole("article", { name: "Around Ben", exact: true });
  await exploreBen(around);
  await expect(page.getByText(t("graph.layout.settling"))).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await around.screenshot({
    path: join(OUT, "graph-explorer-dark.png"),
    animations: "disabled",
    caret: "hide",
  });
  await page.context().close();
});

test("plugins", async ({ browser }) => {
  test.skip(
    BINARY === "",
    "KALZIT_E2E_PLUGIN_BINARY is not set; the pictures need the test plugin",
  );
  const owner = demo.owner;
  const id = "dev.example.numbers";
  const host = (await (await owner.context.get("/api/admin/plugin-host")).json()) as {
    landlockAvailable: boolean;
  };
  // Unsigned only while the package goes in; plugins installed meanwhile keep running.
  await owner.context.patch("/api/admin/plugin-host", {
    data: {
      allowUnsigned: true,
      ...(host.landlockAvailable ? {} : { allowWithoutLandlock: true }),
    },
  });
  const file = test.info().outputPath("numbers.zip");
  writePackage(file, { id, name: "Numbers", publisher: "Example Data GmbH" });
  const installed = await owner.context.post("/api/admin/plugins", {
    data: readFileSync(file),
    headers: { "Content-Type": "application/zip" },
  });
  expect(installed.ok(), await installed.text()).toBe(true);
  for (const step of ["approve", "enable"]) {
    const answer = await owner.context.post(`/api/admin/plugins/${id}/${step}`, {
      ...(step === "approve" ? { data: { version: "1.0.0" } } : {}),
    });
    expect(answer.ok(), await answer.text()).toBe(true);
  }
  await owner.context.patch("/api/admin/plugin-host", { data: { allowUnsigned: false } });
  const created = await owner.context.post(`/api/orgs/${owner.orgId}/datasources`, {
    data: { name: "Numbers", kind: id, settings: { host: "numbers.example.test" }, secrets: {} },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const source = ((await created.json()) as { id: string }).id;
  // One query starts the process, so the page shows it running with its sandbox.
  await owner.context.post(`/api/orgs/${owner.orgId}/query`, {
    data: {
      queries: [{ refId: "A", datasourceId: source, query: { do: "frame" } }],
      timeRange: { from: SCREENSHOT_NOW - 3_600_000, to: SCREENSHOT_NOW },
    },
  });

  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/settings/plugins");
  await expect(page.getByRole("link", { name: "Numbers", exact: true })).toBeVisible();
  await expect(page.getByText(t("plugins.status.running"))).toBeVisible();
  await shoot(page, "plugins");
  await page.goto(`/settings/plugins/${id}`);
  await expect(page.getByRole("heading", { level: 2, name: "Numbers" })).toBeVisible();
  await shoot(page, "plugin-details");
  await page.goto("/settings/plugins#trust");
  await expect(page.getByRole("heading", { name: t("plugins.trust.keys.title") })).toBeVisible();
  await shoot(page, "plugins-trust");
  await page.goto("/data-sources/new");
  await page.getByRole("link", { name: "Numbers", exact: true }).click();
  await expect(page.getByText(t("datasources.kinds.plugin.hint"))).toBeVisible();
  await shoot(page, "data-source-plugin");
  await page.context().close();
});
