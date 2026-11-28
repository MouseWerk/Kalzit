import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type APIRequestContext, type Page, request } from "@playwright/test";
import { OUTPUT_DIR, serverEnv, stop, waitForAddress } from "./global-setup";
import { fixturesDir, unique } from "./support/api";
import { seriousViolations } from "./support/axe";
import { t } from "./support/i18n";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, test } from "./support/test";

/**
 * Map images through the Kalzit server (board Graph081.dc.html, frames 15 to 17; docs/api/map.md):
 * Verwaltung > Karte with its test and one Save, the map panel and the graph layout "Karte" with
 * pictures from a map service on this machine, and a public link. The source is one setting for
 * the whole server, so these run on a server of their own: the other specs keep a server whose
 * maps draw the bundled outlines. The browser only ever asks Kalzit, never the map service.
 */

const OWNER = { email: "maps@example.com", password: "map-images-owner-password-e2e" };
const ATTRIBUTION = "\u00a9 Testkarten und Mitwirkende";
/** A 1x1 PNG, as a map service would answer every picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

let child: ChildProcess | undefined;
let origin = "";
let api: APIRequestContext;
let orgId = "";
let tiles: { server: Server; port: number; hits: string[] };

// One server setting for every step: they run one after the other.
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 } });

async function startTiles(): Promise<typeof tiles> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(PNG);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

async function ok<T>(answer: Promise<import("@playwright/test").APIResponse>, what: string) {
  const response = await answer;
  if (!response.ok()) throw new Error(`${what}: ${response.status()} ${await response.text()}`);
  return (await response.json()) as T;
}

test.beforeAll(async () => {
  const exe = process.env.KALZIT_E2E_EXE;
  const run = process.env.KALZIT_E2E_RUN;
  if (exe === undefined || run === undefined) {
    throw new Error("global setup did not name the binary and run folder");
  }
  const dir = join(run, "map-images");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const log = createWriteStream(join(OUTPUT_DIR, "server-map-images.log"));
  child = spawn(exe, ["serve"], {
    cwd: dir,
    env: serverEnv({
      KALZIT_SERVER_HTTP_ADDR: "127.0.0.1:0",
      KALZIT_PATHS_DATA_DIR: join(dir, "data"),
      KALZIT_SETUP_TOKEN: token,
      KALZIT_SECRETS_KEY: randomBytes(32).toString("base64"),
      KALZIT_SETTING_DATASOURCES_SQLITE_DIRS: JSON.stringify([fixturesDir()]),
      KALZIT_SETTING_APPEARANCE_DEFAULT_LANGUAGE: "en",
      KALZIT_LOG_LEVEL: "info",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await waitForAddress(child, (text) => log.write(text));
  api = await request.newContext({ baseURL: origin });
  await ok(
    api.post("/api/setup", { data: { token, orgName: "Karten", name: "Owner", ...OWNER } }),
    "setup",
  );
  await ok(api.post("/api/auth/login", { data: OWNER }), "sign in");
  const me = await ok<{ orgs: { id: string }[] }>(api.get("/api/me"), "me");
  orgId = me.orgs[0]?.id ?? "";
  tiles = await startTiles();
});

test.afterAll(async () => {
  await api?.dispose();
  tiles?.server.close();
  if (child !== undefined) await stop(child);
});

async function signIn(page: Page): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByLabel(t("access.login.email")).fill(OWNER.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
}

/** The requests of `page` that went anywhere but this Kalzit server. */
function foreignRequests(page: Page): string[] {
  const foreign: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== origin) foreign.push(r.url());
  });
  return foreign;
}

async function mapView(): Promise<{ version: number; source: { enabled: boolean } | null }> {
  return ok(api.get("/api/admin/map"), "map settings");
}

async function dashboard(panel: Record<string, unknown>): Promise<string> {
  const model = {
    schemaVersion: 1,
    title: unique("Lager"),
    timeRange: { from: "now-6h", to: "now" },
    panels: [{ id: "p1", grid: { x: 0, y: 0, w: 24, h: 12 }, ...panel }],
  };
  const made = await ok<{ id: string }>(
    api.post(`/api/orgs/${orgId}/dashboards`, { data: { model } }),
    "create dashboard",
  );
  return made.id;
}

const WAREHOUSES =
  "SELECT 'Lager Nord' AS name, 53.55 AS lat, 9.99 AS lon " +
  "UNION ALL SELECT 'Lager Süd', 48.14, 11.58 UNION ALL SELECT 'Lager Ost', 52.52, 13.40";

test("Verwaltung > Karte is off, tests and saves one source, and switches off with undo", async ({
  page,
  consoleGuard,
}) => {
  // The address without {y} is refused at its field: the browser logs the answer.
  consoleGuard.allow(
    /^error: Failed to load resource: the server responded with a status of 422 .*\/api\/admin\/map\/test/,
  );
  await signIn(page);
  await page.goto(`${origin}/settings/map`);
  const toggle = page.getByRole("switch", { name: t("map.admin.images") });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText(t("map.admin.imagesOff"))).toBeVisible();
  await expect(page.getByText("/api/map/tiles/{z}/{x}/{y}", { exact: true })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await toggle.click();
  const form = page.getByRole("form", { name: t("map.admin.images") });
  const address = form.getByRole("textbox", { name: t("map.admin.url") });
  // A problem stands at its field, and nothing is stored.
  await address.fill(`http://127.0.0.1:${tiles.port}/{z}/{x}.png`);
  await form.getByRole("textbox", { name: t("map.admin.attribution") }).fill(ATTRIBUTION);
  await form.getByRole("button", { name: t("map.admin.test") }).click();
  await expect(address).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByText(t("map.admin.checkField"))).toBeVisible();
  expect((await mapView()).source).toBeNull();

  await address.fill(`http://127.0.0.1:${tiles.port}/{z}/{x}/{y}.png`);
  await form.getByRole("button", { name: t("map.admin.test") }).click();
  await expect(form.getByText(/Map image 6\/33\/21 loaded/)).toBeVisible();
  await form.getByRole("button", { name: t("map.admin.save") }).click();
  await expect(page.getByText(t("map.admin.saved"))).toBeVisible();
  expect((await mapView()).source?.enabled).toBe(true);
  expect(await seriousViolations(page)).toEqual([]);

  // Off applies at once, with undo; undo switches the same source on again.
  await page.getByRole("switch", { name: t("map.admin.images") }).click();
  await expect(page.getByText(t("map.admin.switchedOff"))).toBeVisible();
  await expect.poll(async () => (await mapView()).source?.enabled).toBe(false);
  await page.getByRole("button", { name: t("common.undo") }).click();
  await expect.poll(async () => (await mapView()).source?.enabled).toBe(true);
});

test("the map panel lays the pictures under its points, all of them through Kalzit", async ({
  page,
}) => {
  const source = await ok<{ id: string }>(
    api.post(`/api/orgs/${orgId}/datasources`, {
      data: {
        name: unique("Lager"),
        kind: "sqlite",
        settings: { path: join(fixturesDir(), "sales.db") },
        secrets: {},
      },
    }),
    "create source",
  );
  const dashboardId = await dashboard({
    type: "map",
    title: "Lager",
    targets: [{ refId: "A", datasourceId: source.id, query: { sql: WAREHOUSES } }],
    options: { layers: [{ kind: "points" }] },
  });
  await signIn(page);
  const foreign = foreignRequests(page);
  const served = await page.goto(`${origin}/dashboards/${dashboardId}`);
  // The content security policy stays "this server only" for pictures.
  expect(served?.headers()["content-security-policy"]).toContain("img-src 'self' data: blob:");
  const panel = page.locator(".panel-card").filter({ hasText: "Lager" });
  const images = panel.getByTestId("map-tiles").locator("image");
  await expect(images.first()).toBeAttached();
  for (const image of await images.all()) {
    expect(await image.getAttribute("href")).toMatch(/^\/api\/map\/tiles\/\d+\/\d+\/\d+$/);
  }
  await expect(panel.locator(".map__dot")).toHaveCount(3);
  await expect(panel.getByText(ATTRIBUTION)).toBeVisible();
  await expect(panel.getByText(/map images on/)).toBeVisible();
  await expect.poll(() => tiles.hits.length).toBeGreaterThan(1);
  expect(foreign).toEqual([]);
  expect(await seriousViolations(page)).toEqual([]);

  // A visitor of a public link gets the pictures through the link's own routes.
  const settings = await ok<{ items: { key: string; version: number }[] }>(
    api.get("/api/admin/settings"),
    "settings",
  );
  const version = settings.items.find((s) => s.key === "sharing.public_enabled")?.version ?? 0;
  await ok(
    api.patch("/api/admin/settings/sharing.public_enabled", { data: { value: true, version } }),
    "public sharing",
  );
  const link = await ok<{ token: string }>(
    api.post(`/api/orgs/${orgId}/dashboards/${dashboardId}/public-links`, { data: {} }),
    "public link",
  );
  const visitor = await page.context().browser()?.newContext({ locale: "en-US" });
  if (visitor === undefined) throw new Error("no browser");
  try {
    const publicPage = await visitor.newPage();
    const outside = foreignRequests(publicPage);
    await publicPage.goto(`${origin}/public/dashboards/${link.token}`);
    const shared = publicPage.getByTestId("map-tiles").locator("image");
    await expect(shared.first()).toBeAttached();
    expect(await shared.first().getAttribute("href")).toMatch(
      new RegExp(`^/api/public/dashboards/${link.token}/map/tiles/\\d+/\\d+/\\d+$`),
    );
    await expect(publicPage.getByText(ATTRIBUTION)).toBeVisible();
    expect(outside).toEqual([]);
  } finally {
    await visitor.close();
  }

  // Off applies at once: the panel draws the bundled outlines again.
  const off = await mapView();
  await ok(
    api.put("/api/admin/map/enabled", { data: { enabled: false, version: off.version } }),
    "switch off",
  );
  await page.reload();
  await expect(panel.getByTestId("map-outlines")).toBeVisible();
  await expect(panel.getByTestId("map-tiles")).toHaveCount(0);
  await expect(panel.getByText(t("map.outlines.note")).first()).toBeVisible();
  const on = await mapView();
  await ok(
    api.put("/api/admin/map/enabled", { data: { enabled: true, version: on.version } }),
    "switch on",
  );
});

test("the graph layout Karte puts the customers on the same map, the orders beside it", async ({
  page,
  consoleGuard,
}) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
  const address = serviceAddress("KALZIT_E2E_NEO4J");
  const source = await ok<{ id: string }>(
    api.post(`/api/orgs/${orgId}/datasources`, {
      data: {
        name: unique("Shop"),
        kind: "neo4j",
        settings: { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        secrets: { password: GRAPH_FIXTURE.neo4jPassword },
      },
    }),
    "create neo4j source",
  );
  const title = "Customers on the map";
  const dashboardId = await dashboard({
    type: "network",
    title,
    targets: [
      {
        refId: "A",
        datasourceId: source.id,
        query: { cypher: "MATCH (c:Customer)-[p:PLACED]->(o:Order) RETURN c, p, o" },
      },
    ],
    options: { layout: "map" },
  });
  await signIn(page);
  const foreign = foreignRequests(page);
  await page.goto(`${origin}/dashboards/${dashboardId}`);
  const panel = page.locator(".panel-card").filter({ hasText: title });
  const drawing = panel.getByRole("application", { name: title, exact: true });
  const noWebgl = panel.getByText(t("graph.notice.noWebgl"), { exact: true });
  await expect(drawing.or(noWebgl)).toBeVisible({ timeout: 15_000 });
  test.skip(await noWebgl.isVisible(), "this browser has no WebGL 2 to draw the graph on");

  // The five customers have a place, the eight orders stand in the strip beside the map.
  await expect(
    panel.getByText(t("graph.layout.placed.map", { placed: 5, count: 13, rest: 8 })),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: t("graph.layout.button", { name: t("graph.layout.map") }) }),
  ).toBeVisible();
  const map = panel.getByTestId("graph-map");
  await expect(map.getByTestId("map-tiles").locator("image").first()).toBeAttached();
  await expect(map.getByText(ATTRIBUTION)).toBeVisible();
  expect(foreign).toEqual([]);

  // Without map images the same map draws the bundled outlines.
  const view = await mapView();
  await ok(
    api.put("/api/admin/map/enabled", { data: { enabled: false, version: view.version } }),
    "switch off",
  );
  await page.reload();
  await expect(panel.getByTestId("graph-map").getByTestId("map-outlines")).toBeAttached();
  await expect(panel.getByTestId("graph-map").getByText(t("map.outlines.note"))).toBeVisible();
  // The layout menu says how many have a place, and offers the latitude and longitude.
  await panel
    .getByRole("button", { name: t("graph.layout.button", { name: t("graph.layout.map") }) })
    .click();
  await expect(page.getByText(t("graph.layout.about.map", { placed: 5, count: 13 }))).toBeVisible();
  await expect(page.getByLabel(t("graph.layout.option.lat"))).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});
