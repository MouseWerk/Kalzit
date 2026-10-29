import { createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { Api, baseUrl, fixturesDir } from "../support/api";
import { t } from "../support/i18n";
import {
  BINARY,
  filesTable,
  type PublisherKey,
  packageOf,
  publisherKey,
  testPluginPackage,
} from "../support/plugin";
import { boltTarget, GRAPH_FIXTURE } from "../support/services";
import { ASK_QUESTION, type Assistant, PUE_QUERY, startAssistant } from "./assistant";
import { GALLERY_MONGO, GALLERY_NOW, HALLS, seedLogs, writeDatacenterDatabase } from "./datacenter";

/**
 * The gallery renders of the website: curated scenes of Kalzit on the fictional data center
 * "Site Basalt" (gallery/datacenter.ts), 1600 x 1000 at twice the device scale, dark and light.
 * Needs the services of the e2e job with the gallery data (`e2e-services.sh seed-gallery`):
 * MongoDB, OpenSearch and Neo4j. Run by .github/workflows/gallery.yml; see docs/screenshots/
 * README.md.
 */

const OUT = resolve(
  process.env.KALZIT_GALLERY_OUT ?? join(import.meta.dirname, "..", ".output", "gallery"),
);

const OWNER = {
  name: "Maria Keller",
  email: "maria.keller@kalzit.test",
  password: "gallery-password-maria",
  orgName: "Basalt Operations",
} as const;

const SCHEMES = ["dark", "light"] as const;
type Scheme = (typeof SCHEMES)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Seeded {
  sql: string;
  mongo: string;
  search: string;
  graph: string;
  overview: string;
  topology: string;
  graphViews: string;
  explorer: string;
  documents: string;
  allSources: string;
  live: string;
  pipeline: string;
  steps: string;
  /** The SQLite file of the metrics, which the stand-in model reads its figures from. */
  dbFile: string;
  /** The saved analysis of the Explore AI pictures. */
  pue: string;
  /** The AI providers: the local model server and a gateway whose model runs elsewhere. */
  providers: string[];
  /** The dashboard with the panels of the KPI tile plugin. */
  pluginPanels: string;
}

/**
 * The ids of what the first scene seeded, kept in a file in the run's fixture folder (below the
 * system temp folder, made and removed by global-setup.ts, never in the repository): one worker
 * runs the scenes in order, and after a failed scene it starts anew, so a module variable would
 * be lost while the server and its data stay.
 */
function seededFile(): string {
  return join(fixturesDir(), "gallery-seeded.json");
}

let cached: Seeded | undefined;

function seeded(): Seeded {
  cached ??= JSON.parse(readFileSync(seededFile(), "utf8")) as Seeded;
  return cached;
}

function service(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") {
    throw new Error(`${name} is not set; the gallery needs the services of e2e-services.sh`);
  }
  return value;
}

/** A page whose clock stands at the gallery moment, so relative ranges show the example data. */
async function openPage(
  browser: Browser,
  scheme: Scheme,
  viewport = { width: 1600, height: 1000 },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport,
    deviceScaleFactor: 2,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(GALLERY_NOW);
  // The server stamps saves and memberships with the real time of the run; the pictures show
  // them at the gallery moment instead.
  for (const pattern of [
    /\/api\/orgs\/[^/]+\/(members|dashboards|analyses)(\?|$)/,
    /\/api\/orgs\/[^/]+\/analyses\/[^/?]+(\?|$)/,
    // The chats of Ask, the installed plugins with their log, and the catalog's last check.
    /\/api\/orgs\/[^/]+\/ai\/chats(\/[^/?]+)?(\?|$)/,
    /\/api\/(admin|orgs\/[^/]+)\/ai\/providers(\?|$)/,
    /\/api\/admin\/plugins(\/[^?]+)?(\?|$)/,
    /\/api\/admin\/plugin-(keys|catalog)(\?|$)/,
  ]) {
    await context.route(pattern, async (route) => {
      // Only the answers that are JSON documents; a stream or a change passes untouched.
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      if (!(response.headers()["content-type"] ?? "").includes("application/json")) {
        return route.fulfill({ response });
      }
      const body: unknown = await response.json();
      await route.fulfill({ response, json: atGalleryTime(body, Date.now()) });
    });
  }
  // AI usage is counted per calendar day: the days of the run become the gallery's days.
  await context.route(/\/api\/(admin|orgs\/[^/]+)\/ai\/usage(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    await route.fulfill({ response, json: atGalleryDay(body, Date.now()) });
  });
  return page;
}

/** Moves every `day` (YYYY-MM-DD) from the run's calendar to the gallery's, keeping the gaps. */
function atGalleryDay(value: unknown, realNow: number): unknown {
  if (Array.isArray(value)) return value.map((item) => atGalleryDay(item, realNow));
  if (value === null || typeof value !== "object") return value;
  const shift = Math.round((Date.parse(day(GALLERY_NOW)) - Date.parse(day(realNow))) / DAY);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "day" && typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)
        ? day(Date.parse(item) + shift * DAY)
        : atGalleryDay(item, realNow),
    ]),
  );
}

/** The calendar day of a moment in UTC, as the usage counts it. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Moves every timestamp near the real time to the gallery moment, keeping whole days apart. */
function atGalleryTime(value: unknown, realNow: number): unknown {
  if (Array.isArray(value)) return value.map((item) => atGalleryTime(item, realNow));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, atGalleryTime(item, realNow)]),
    );
  }
  const isTimestamp =
    typeof value === "number" && Number.isInteger(value) && Math.abs(value - realNow) < 400 * DAY;
  return isTimestamp ? GALLERY_NOW + Math.round((value - realNow) / DAY) * DAY : value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("access.login.email")).fill(OWNER.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
}

/** Settles the page (requests, fonts, charts), hides focus and pointer, and saves the PNG. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  // Charts and the graph renderer draw on the next frames after the last data arrived.
  await page.waitForTimeout(600);
  const png = await page.screenshot({
    path: join(OUT, `${name}.png`),
    animations: "disabled",
    caret: "hide",
  });
  writeFileSync(join(OUT, `${name}.webp`), await toWebp(page, png));
}

/**
 * The PNG as WebP for the website, encoded by the browser itself, so the workflow needs no
 * image tools. A blank page of its own: Kalzit's content security policy does not apply there.
 */
async function toWebp(page: Page, png: Buffer): Promise<Buffer> {
  const blank = await page.context().newPage();
  try {
    const encoded = await blank.evaluate(async (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.9 });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let text = "";
      for (let i = 0; i < buffer.length; i += 0x8000) {
        text += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      }
      return btoa(text);
    }, png.toString("base64"));
    return Buffer.from(encoded, "base64");
  } finally {
    await blank.close();
  }
}

async function openDashboard(page: Page, id: string, title: string): Promise<void> {
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

function card(page: Page, title: string): Locator {
  return page.getByRole("article", { name: title, exact: true });
}

/** No panel shows an error or an empty result. */
async function noEmptyPanels(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator(".panel-empty")).toHaveCount(0);
  // Alert regions stay on the page while empty; only one with a message counts.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
}

/** Waits until a graph panel has drawn and its layout has settled. */
async function graphDrawn(scope: Locator, title: string): Promise<void> {
  await expect(scope.getByRole("application", { name: title, exact: true })).toBeVisible();
  await expect(scope.getByText(t("graph.layout.settling"))).toHaveCount(0);
}

/** Selects a node through the panel's table and switches back to the drawing. */
async function selectNode(scope: Locator, title: string, node: string): Promise<void> {
  await graphDrawn(scope, title);
  await scope.getByRole("button", { name: t("graph.showTable"), exact: true }).click();
  await scope.getByRole("button", { name: node, exact: true }).click();
}

/** Switches the pressed table toggle off again, back to the drawing. */
async function showDrawing(scope: Locator, title: string): Promise<void> {
  const toggle = scope.getByRole("button", { name: t("graph.showTable"), exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await graphDrawn(scope, title);
}

// ---------------------------------------------------------------------------------------------
// Example data and the dashboards on it.

const sqlTarget = (datasourceId: string, sql: string) => [
  { refId: "A", datasourceId, query: { sql } },
];

const PER_HALL_POWER = `SELECT ts AS time, ${HALLS.map(
  (hall) => `SUM(CASE WHEN hall = '${hall}' THEN power_w END) AS "${hall}"`,
).join(", ")} FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts`;

const INLET_PER_ROW = `SELECT ts AS time, ${[1, 2, 3, 4]
  .map((row) => `MAX(CASE WHEN row = ${row} THEN inlet_c END) AS "Row ${row}"`)
  .join(", ")} FROM rack_metrics WHERE hall = $hall AND $__timeFilter(ts) GROUP BY ts ORDER BY ts`;

const THRESHOLDS_TEMP = {
  mode: "absolute",
  steps: [
    { value: null, tone: "ok" },
    { value: 26, tone: "warn" },
    { value: 28, tone: "critical" },
  ],
};

const OVERVIEW = "Site Basalt overview";

function overviewDashboard(sql: string): Record<string, unknown> {
  const stat = (
    id: string,
    title: string,
    x: number,
    query: string,
    defaults: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ) => ({
    id,
    type: "stat",
    title,
    grid: { x, y: 0, w: 6, h: 4 },
    targets: sqlTarget(sql, query),
    options: { reducer: "last", ...options },
    fieldConfig: { defaults, overrides: [] },
  });
  return {
    schemaVersion: 2,
    title: OVERVIEW,
    timeRange: { from: "now-24h", to: "now" },
    variables: [
      {
        name: "hall",
        label: "Hall",
        type: "query",
        datasourceId: sql,
        query: { sql: "SELECT DISTINCT hall FROM rack_metrics ORDER BY hall" },
        current: { value: "Hall B" },
      },
    ],
    panels: [
      stat(
        "pue",
        "PUE, whole site",
        0,
        "SELECT ts AS time, SUM(facility_w) * 1.0 / SUM(it_w) AS PUE FROM hall_power WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { decimals: 2 },
      ),
      stat(
        "it",
        "IT load",
        6,
        "SELECT ts AS time, SUM(power_w) AS IT FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { unit: "watt", decimals: 1 },
      ),
      stat(
        "hottest",
        "Hottest rack inlet, °C",
        12,
        "SELECT ts AS time, MAX(inlet_c) AS inlet FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { unit: "celsius", decimals: 1, thresholds: THRESHOLDS_TEMP },
        { colorMode: "value" },
      ),
      stat(
        "network",
        "Network, Gbit/s",
        18,
        "SELECT ts AS time, SUM(ingress_bps + egress_bps) AS throughput FROM network WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { unit: "bitsps", decimals: 1 },
      ),
      {
        id: "power",
        type: "timeseries",
        title: "IT power per hall",
        grid: { x: 0, y: 4, w: 14, h: 9 },
        targets: sqlTarget(sql, PER_HALL_POWER),
        options: {},
        fieldConfig: { defaults: { unit: "watt", fillOpacity: 12 }, overrides: [] },
      },
      {
        id: "inlet",
        type: "timeseries",
        title: "Inlet temperature per row",
        grid: { x: 14, y: 4, w: 10, h: 9 },
        targets: sqlTarget(sql, INLET_PER_ROW),
        options: {},
        fieldConfig: { defaults: { unit: "celsius", decimals: 1 }, overrides: [] },
      },
      {
        id: "rows",
        type: "bar",
        title: "Average power per row",
        grid: { x: 0, y: 13, w: 7, h: 8 },
        targets: sqlTarget(
          sql,
          "SELECT 'Row ' || row AS row, ROUND(AVG(total) / 1000.0, 1) AS power FROM (SELECT ts, row, SUM(power_w) AS total FROM rack_metrics WHERE hall = $hall AND $__timeFilter(ts) GROUP BY ts, row) GROUP BY row ORDER BY row",
        ),
        options: { legend: { mode: "hidden", placement: "bottom", values: [] } },
        // In kW with a custom suffix: the watt unit writes the axis' zero as "0 nW".
        fieldConfig: { defaults: { unit: "suffix:kW", color: "chart-1" }, overrides: [] },
      },
      {
        id: "pue-halls",
        type: "bargauge",
        title: "PUE per hall",
        grid: { x: 7, y: 13, w: 6, h: 8 },
        targets: sqlTarget(
          sql,
          "SELECT hall, ROUND(AVG(facility_w * 1.0 / it_w), 3) AS PUE FROM hall_power WHERE $__timeFilter(ts) GROUP BY hall ORDER BY hall",
        ),
        options: { reducer: "last", displayMode: "basic", orientation: "horizontal" },
        fieldConfig: {
          defaults: {
            decimals: 2,
            min: 1,
            max: 1.6,
            thresholds: {
              mode: "absolute",
              steps: [
                { value: null, tone: "ok" },
                { value: 1.4, tone: "warn" },
                { value: 1.5, tone: "critical" },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: "racks",
        type: "table",
        title: "Racks with the highest power draw",
        grid: { x: 13, y: 13, w: 11, h: 8 },
        targets: sqlTarget(
          sql,
          'SELECT rack AS Rack, hall AS Hall, ROUND(AVG(power_w) / 1000.0, 1) AS "Avg kW", ROUND(MAX(inlet_c), 1) AS "Max inlet °C", ROUND(AVG(cpu_pct)) AS "Avg CPU %" FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY rack, hall ORDER BY 3 DESC LIMIT 8',
        ),
        options: {},
        fieldConfig: oneDecimal(["Avg kW", "Max inlet °C"]),
      },
    ],
  };
}

/** One decimal for these table columns, so 7 reads 7.0 beside 7.3. */
function oneDecimal(names: string[]): Record<string, unknown> {
  return {
    defaults: {},
    overrides: names.map((value) => ({
      matcher: { type: "name", value },
      properties: { decimals: 1 },
    })),
  };
}

function graphPanel(
  datasourceId: string,
  id: string,
  type: string,
  title: string,
  grid: { x: number; y: number; w: number; h: number },
  cypher: string,
  options: Record<string, unknown> = {},
) {
  return {
    id,
    type,
    title,
    grid,
    targets: [{ refId: "A", datasourceId, query: { cypher } }],
    options,
  };
}

const TOPOLOGY = "Network and power topology";
const TOPOLOGY_PANEL = "Switches, servers, racks, power and cooling";
const GRAPH_VIEWS = "Site Basalt structure";
const EXPLORER = "Explore the topology";
const PANEL = {
  hierarchy: "Site, halls, rows, racks and servers",
  network: "srv-b1-01-1 to core-1",
  power: "Power feeds of srv-c2-02-2",
  explorer: "Around spine-a1",
} as const;

const DOCUMENTS = "Assets and incidents";
const ALL_SOURCES = "Site Basalt, all sources";
const LIVE = "Rack temperatures, live";
const PIPELINE = "In-service servers of hall B";
const STEPS = "Inlet temperature hall B with trend";

/** A pipeline as a person writes it: each stage indented on lines of its own. */
function pipelineText(stages: unknown[]): string {
  return `[\n${stages.map((stage) => JSON.stringify(stage, null, 2)).join(",\n")}\n]`;
}

async function seed(): Promise<Seeded> {
  const dbFile = join(fixturesDir(), "datacenter.db");
  writeDatacenterDatabase(dbFile);
  const searchBase = service("KALZIT_E2E_OPENSEARCH").replace(/\/$/, "");
  const logIndex = "kalzit-gallery-logs";
  await seedLogs(searchBase, logIndex);

  const owner = await Api.signIn(OWNER.email, OWNER.password);
  try {
    const jonas = await owner.createMember("Jonas Becker", "admin");
    const lea = await owner.createMember("Lea Hoffmann", "editor");
    const tim = await owner.createMember("Tim Schulz", "editor");
    await owner.createMember("Sofia Wagner", "viewer");
    await owner.createTeam("Facility", [jonas.id, tim.id]);
    await owner.createTeam("Network", [lea.id]);

    const sql = await owner.createSqliteSource("Site metrics (SQLite)", dbFile);
    const mongo = await owner.createSource(
      "Asset inventory (MongoDB)",
      "mongodb",
      {
        hosts: service("KALZIT_E2E_MONGODB"),
        database: GALLERY_MONGO.database,
        user: GALLERY_MONGO.user,
      },
      { password: GALLERY_MONGO.password },
    );
    const search = await owner.createSource("Device logs (OpenSearch)", "elasticsearch", {
      url: searchBase,
      index: logIndex,
    });
    const graph = await owner.createSource(
      "Topology (Neo4j)",
      "neo4j",
      { ...boltTarget(service("KALZIT_E2E_NEO4J")), user: GRAPH_FIXTURE.neo4jUser },
      { password: GRAPH_FIXTURE.neo4jPassword },
    );

    const overview = await owner.createDashboard(overviewDashboard(sql));

    const topology = await owner.createDashboard({
      schemaVersion: 2,
      title: TOPOLOGY,
      timeRange: { from: "now-24h", to: "now" },
      variables: [],
      panels: [
        graphPanel(
          graph,
          "topology",
          "network",
          TOPOLOGY_PANEL,
          { x: 0, y: 0, w: 24, h: 20 },
          "MATCH (a)-[r:LINK|UPLINK|FEEDS|BACKS_UP|COOLS|MOUNTED_IN|CONTAINS]->(b) WHERE NOT a:Site AND NOT a:Hall RETURN a, r, b",
        ),
      ],
    });

    const graphViews = await owner.createDashboard({
      schemaVersion: 2,
      title: GRAPH_VIEWS,
      timeRange: { from: "now-24h", to: "now" },
      variables: [],
      panels: [
        graphPanel(
          graph,
          "tree",
          "hierarchy",
          PANEL.hierarchy,
          { x: 0, y: 0, w: 24, h: 13 },
          "MATCH (a)-[r:CONTAINS]->(b) RETURN a, r, b",
          { sizeBy: "" },
        ),
        graphPanel(
          graph,
          "uplinks",
          "path",
          PANEL.network,
          { x: 0, y: 13, w: 12, h: 7 },
          "MATCH p = allShortestPaths((s:Server {name: 'srv-b1-01-1'})-[:LINK|UPLINK*..4]->(c:Switch {name: 'core-1'})) RETURN p",
        ),
        graphPanel(
          graph,
          "feeds",
          "path",
          PANEL.power,
          { x: 12, y: 13, w: 12, h: 7 },
          "MATCH p = allShortestPaths((g:Utility)-[:FEEDS|CONTAINS*..6]->(s:Server {name: 'srv-c2-02-2'})) RETURN p",
        ),
      ],
    });

    const explorer = await owner.createDashboard({
      schemaVersion: 2,
      title: EXPLORER,
      timeRange: { from: "now-24h", to: "now" },
      variables: [],
      panels: [
        graphPanel(
          graph,
          "explorer",
          "network",
          PANEL.explorer,
          { x: 0, y: 0, w: 24, h: 20 },
          "MATCH (s:Switch {name: 'spine-a1'}) RETURN s",
          { explorer: true, expandLimit: 12 },
        ),
      ],
    });

    const mongoTarget = (collection: string, stages: unknown[]) => [
      {
        refId: "A",
        datasourceId: mongo,
        query: { collection, pipeline: pipelineText(stages) },
      },
    ];
    const lastWeek = { $gte: { $date: new Date(GALLERY_NOW - 7 * DAY).toISOString() } };
    const documents = await owner.createDashboard({
      schemaVersion: 2,
      title: DOCUMENTS,
      timeRange: { from: "now-7d", to: "now" },
      variables: [],
      panels: [
        {
          id: "incidents",
          type: "documents",
          title: "Incidents, newest first",
          grid: { x: 0, y: 0, w: 11, h: 20 },
          targets: mongoTarget("incidents", [
            { $match: { openedAt: lastWeek } },
            { $sort: { openedAt: -1 } },
          ]),
          options: {},
        },
        {
          id: "schema",
          type: "schema",
          title: "Fields of the asset records",
          grid: { x: 11, y: 0, w: 13, h: 8 },
          targets: mongoTarget("assets", []),
          options: {},
        },
        {
          id: "bios",
          type: "distribution",
          title: "BMC firmware versions",
          grid: { x: 11, y: 8, w: 6, h: 12 },
          targets: mongoTarget("assets", []),
          options: { path: "firmware.bmc" },
        },
        {
          id: "vendor",
          type: "distribution",
          title: "Servers per vendor",
          grid: { x: 17, y: 8, w: 7, h: 12 },
          targets: mongoTarget("assets", []),
          options: { path: "vendor" },
        },
      ],
    });

    const allSources = await owner.createDashboard({
      schemaVersion: 2,
      title: ALL_SOURCES,
      timeRange: { from: "now-24h", to: "now" },
      variables: [],
      panels: [
        {
          id: "pue",
          type: "timeseries",
          title: "PUE per hall (SQLite)",
          grid: { x: 0, y: 0, w: 14, h: 9 },
          targets: sqlTarget(
            sql,
            `SELECT ts AS time, ${HALLS.map(
              (hall) =>
                `MAX(CASE WHEN hall = '${hall}' THEN facility_w * 1.0 / it_w END) AS "${hall}"`,
            ).join(", ")} FROM hall_power WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts`,
          ),
          options: {},
          fieldConfig: { defaults: { decimals: 2 }, overrides: [] },
        },
        {
          id: "warnings",
          type: "bar",
          title: "Warnings and errors per device (OpenSearch)",
          grid: { x: 14, y: 0, w: 10, h: 9 },
          targets: [
            {
              refId: "A",
              datasourceId: search,
              query: {
                dsl: {
                  query: { terms: { level: ["warning", "error"] } },
                  aggs: {
                    device: { terms: { field: "host", size: 8, order: { _count: "desc" } } },
                  },
                },
              },
            },
          ],
          options: { legend: { mode: "hidden", placement: "bottom", values: [] } },
          fieldConfig: { defaults: { color: "chart-3" }, overrides: [] },
        },
        {
          id: "severity",
          type: "distribution",
          title: "Incidents by severity, last 7 days (MongoDB)",
          grid: { x: 0, y: 9, w: 9, h: 11 },
          targets: mongoTarget("incidents", [{ $match: { openedAt: lastWeek } }]),
          options: { path: "severity" },
        },
        graphPanel(
          graph,
          "power",
          "network",
          "Power chain from grid to racks (Neo4j)",
          { x: 9, y: 9, w: 15, h: 11 },
          "MATCH (a)-[r:FEEDS|BACKS_UP]->(b) RETURN a, r, b",
        ),
      ],
    });

    const live = await owner.createDashboard({
      schemaVersion: 2,
      title: LIVE,
      // Live runs on the server, whose clock is not the pictures' fixed one: a fixed range that
      // ends at the gallery moment, where the data lies.
      timeRange: {
        from: new Date(GALLERY_NOW - 6 * HOUR).toISOString(),
        to: new Date(GALLERY_NOW).toISOString(),
      },
      refreshSeconds: 30,
      variables: [],
      panels: [
        {
          id: "rows",
          type: "timeseries",
          title: "Inlet temperature per row, Hall B",
          grid: { x: 0, y: 0, w: 16, h: 11 },
          targets: sqlTarget(sql, INLET_PER_ROW.replace("$hall", "'Hall B'")),
          options: {},
          fieldConfig: {
            defaults: { unit: "celsius", decimals: 1, thresholds: THRESHOLDS_TEMP },
            overrides: [],
          },
        },
        {
          id: "hottest",
          type: "stat",
          title: "Hottest rack inlet, Hall B",
          grid: { x: 16, y: 0, w: 8, h: 11 },
          targets: sqlTarget(
            sql,
            "SELECT ts AS time, MAX(inlet_c) AS inlet FROM rack_metrics WHERE hall = 'Hall B' AND $__timeFilter(ts) GROUP BY ts ORDER BY ts",
          ),
          options: { reducer: "last", colorMode: "value" },
          fieldConfig: {
            defaults: { unit: "celsius", decimals: 1, thresholds: THRESHOLDS_TEMP },
            overrides: [],
          },
        },
        {
          id: "racks",
          type: "table",
          title: "Racks in Hall B, latest reading",
          grid: { x: 0, y: 11, w: 24, h: 9 },
          targets: sqlTarget(
            sql,
            'SELECT rack AS Rack, row AS Row, inlet_c AS "Inlet °C", outlet_c AS "Outlet °C", ROUND(power_w / 1000.0, 1) AS kW, cpu_pct AS "CPU %" FROM rack_metrics WHERE hall = \'Hall B\' AND ts = (SELECT MAX(ts) FROM rack_metrics WHERE $__timeFilter(ts)) ORDER BY inlet_c DESC LIMIT 8',
          ),
          options: {},
          fieldConfig: oneDecimal(["Inlet °C", "Outlet °C", "kW", "CPU %"]),
        },
      ],
    });

    const pipeline = await owner.createAnalysis({
      schemaVersion: 1,
      title: PIPELINE,
      description: "Servers in service in hall B, the heaviest power draw first.",
      timeRange: { from: "now-24h", to: "now" },
      targets: mongoTarget("assets", [
        { $match: { status: "in service", "location.hall": "Hall B" } },
        { $sort: { powerDrawW: -1 } },
        {
          $project: {
            _id: 0,
            hostname: 1,
            role: 1,
            vendor: 1,
            location: 1,
            firmware: 1,
            powerDrawW: 1,
          },
        },
      ]),
      steps: [],
      visualization: { type: "documents", options: {} },
    });

    const steps = await owner.createAnalysis({
      schemaVersion: 1,
      title: STEPS,
      description: "The average rack inlet in hall B, smoothed over an hour, with its trend.",
      timeRange: { from: "now-24h", to: "now" },
      targets: sqlTarget(
        sql,
        "SELECT ts AS time, ROUND(AVG(inlet_c), 2) AS inlet FROM rack_metrics WHERE hall = 'Hall B' AND $__timeFilter(ts) GROUP BY ts ORDER BY ts",
      ),
      steps: [
        {
          id: "smooth",
          type: "movingAverage",
          frame: "A",
          field: "inlet",
          window: 12,
          name: "hourly average",
        },
        { id: "trend", type: "trend", frame: "A", field: "inlet", output: "fitted", name: "trend" },
      ],
      visualization: { type: "timeseries", options: {} },
    });

    const pue = await owner.createAnalysis({
      schemaVersion: 1,
      title: PUE_TITLE,
      description: "Power usage effectiveness and IT load of each hall over the day.",
      timeRange: { from: "now-24h", to: "now" },
      targets: sqlTarget(sql, PUE_QUERY),
      steps: [],
      visualization: { type: "table", options: {} },
    });
    const providers = await seedAi(owner, sql, dbFile);
    const pluginPanels = await seedPlugins(owner, sql);

    return {
      sql,
      mongo,
      search,
      graph,
      overview,
      topology,
      graphViews,
      explorer,
      documents,
      allSources,
      live,
      pipeline,
      steps,
      dbFile,
      pue,
      providers,
      pluginPanels,
    };
  } finally {
    await owner.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// AI: a stand-in model server, two providers, the metrics source open to AI.

const PUE_TITLE = "PUE and IT load per hall";

/** The stand-in of this worker; a failed scene starts a new worker, which starts it again. */
let assistant: Assistant | undefined;

async function setServerSetting(api: Api, key: string, value: unknown): Promise<void> {
  const list = (await (await api.context.get("/api/admin/settings")).json()) as {
    items: { key: string; version: number }[];
  };
  const version = list.items.find((item) => item.key === key)?.version ?? 0;
  const response = await api.context.patch(`/api/admin/settings/${key}`, {
    data: { value, version },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * The stand-in running in this worker, with the providers pointing at it: when Ollama's port
 * was taken and a new worker got another one, the providers move to it.
 */
async function ensureAssistant(): Promise<void> {
  if (assistant !== undefined) return;
  assistant = await startAssistant(seeded().dbFile, seeded().sql);
  const owner = await Api.signIn(OWNER.email, OWNER.password);
  try {
    const list = (await (await owner.context.get("/api/admin/ai/providers")).json()) as {
      items: { id: string; baseUrl: string; updatedAt: number }[];
    };
    for (const provider of list.items) {
      if (provider.baseUrl === assistant.baseUrl) continue;
      const moved = await owner.context.patch(`/api/admin/ai/providers/${provider.id}`, {
        data: { baseUrl: assistant.baseUrl, expectedUpdatedAt: provider.updatedAt },
      });
      expect(moved.ok(), await moved.text()).toBe(true);
    }
  } finally {
    await owner.dispose();
  }
}

/**
 * Two OpenAI-compatible providers on the stand-in: a local model server, the default, and a
 * gateway marked as sending data out of the network, chosen for summaries. AI on, the metrics
 * source open to AI.
 */
async function seedAi(owner: Api, sql: string, dbFile: string): Promise<string[]> {
  assistant = await startAssistant(dbFile, sql);
  const providers: string[] = [];
  for (const input of [
    {
      name: "Local model (Ollama)",
      baseUrl: assistant.baseUrl,
      model: "llama3.3:70b",
      isDefault: true,
      leavesNetwork: "no",
    },
    {
      name: "LiteLLM gateway",
      baseUrl: assistant.baseUrl,
      model: "gpt-4.1-mini",
      isDefault: false,
      leavesNetwork: "yes",
    },
  ]) {
    const created = await owner.context.post("/api/admin/ai/providers", {
      data: { kind: "openai", ...input },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const { id } = (await created.json()) as { id: string };
    const tested = await owner.context.post(`/api/admin/ai/providers/${id}/test`, { data: {} });
    expect(((await tested.json()) as { ok: boolean }).ok).toBe(true);
    providers.push(id);
  }
  await setServerSetting(owner, "ai.enabled", true);
  await setServerSetting(owner, "ai.provider_summarize", providers[1]);
  const access = await owner.context.put(`/api/orgs/${owner.orgId}/datasources/${sql}/ai-access`, {
    data: { readable: true, excludedFields: [] },
  });
  expect(access.ok(), await access.text()).toBe(true);
  return providers;
}

// ---------------------------------------------------------------------------------------------
// Plugins: a publisher key, a data source plugin and the example KPI tile, all signed.

const PUBLISHER = "Basalt Engineering";
const BACNET = { id: "dev.basalt.bacnet", name: "BACnet sensors" } as const;
const KPI = "dev.basalt.panel-kpi";
const PLUGIN_PANELS = "Site Basalt at a glance";

/** The key the plugin pictures sign with; made once per worker, trusted in the first one. */
let signingKey: PublisherKey | undefined;

function key(): PublisherKey {
  if (signingKey === undefined) {
    const stored = readFileSync(join(fixturesDir(), "gallery-key.json"), "utf8");
    const { privateKey, ...rest } = JSON.parse(stored) as Omit<PublisherKey, "privateKey"> & {
      privateKey: string;
    };
    signingKey = { ...rest, privateKey: createPrivateKey(privateKey) };
  }
  return signingKey;
}

/** The example panel plugin (examples/plugins/panel-kpi) as this publisher's, signed. */
function kpiPackage(): Buffer {
  const dir = join(import.meta.dirname, "..", "..", "..", "examples", "plugins", "panel-kpi");
  const files = [{ name: "panel.js", data: new Uint8Array(readFileSync(join(dir, "panel.js"))) }];
  const manifest = readFileSync(join(dir, "kalzit-plugin.toml"), "utf8")
    .replace(/^id = .*$/m, `id = "${KPI}"`)
    .replace(/^publisher = .*$/m, `publisher = "${PUBLISHER}"`)
    // The example asks for the version it ships with; the pictures run on the current one.
    .replace(/^min_kalzit = .*$/m, 'min_kalzit = "0.1.0"');
  return packageOf(`${manifest.trimEnd()}\n\n${filesTable(files)}`, files, key());
}

/** A package of the test plugin as one of this publisher's data source plugins. */
function dataSourcePackage(
  id: string,
  name: string,
  description: string,
  defaultPort: number,
): Buffer {
  return testPluginPackage(
    {
      id,
      name,
      publisher: PUBLISHER,
      description,
      network: [['setting = "host"', 'form = "host"', `default_port = ${defaultPort}`]],
    },
    key(),
  );
}

async function installSigned(owner: Api, id: string, file: Buffer): Promise<void> {
  const installed = await owner.context.post("/api/admin/plugins", {
    headers: { "Content-Type": "application/zip" },
    data: file,
  });
  expect(installed.ok(), await installed.text()).toBe(true);
  const { version } = (await installed.json()) as { version?: string };
  for (const [step, data] of [
    ["approve", { version: version ?? "1.0.0" }],
    ["enable", undefined],
  ] as const) {
    const answer = await owner.context.post(
      `/api/admin/plugins/${id}/${step}`,
      data === undefined ? {} : { data },
    );
    expect(answer.ok(), await answer.text()).toBe(true);
  }
}

const kpiPanel = (
  datasourceId: string,
  id: string,
  title: string,
  x: number,
  sql: string,
  options: Record<string, unknown>,
) => ({
  id,
  type: KPI,
  title,
  grid: { x, y: 0, w: 6, h: 6 },
  targets: sqlTarget(datasourceId, sql),
  options,
});

async function seedPlugins(owner: Api, sql: string): Promise<string> {
  expect(BINARY, "KALZIT_E2E_PLUGIN_BINARY names the test plugin").not.toBe("");
  const made = publisherKey();
  writeFileSync(
    join(fixturesDir(), "gallery-key.json"),
    JSON.stringify({
      keyId: made.keyId,
      publicKey: made.publicKey,
      privateKey: made.privateKey.export({ format: "pem", type: "pkcs8" }),
    }),
  );
  signingKey = made;
  const trusted = await owner.context.post("/api/admin/plugin-keys", {
    data: { name: PUBLISHER, publicKey: made.publicKey },
  });
  expect(trusted.ok(), await trusted.text()).toBe(true);
  // Without Landlock (some CI kernels) plugins start only when the administrator allows it.
  const host = (await (await owner.context.get("/api/admin/plugin-host")).json()) as {
    landlockAvailable?: boolean;
  };
  if (host.landlockAvailable === false) {
    await owner.context.patch("/api/admin/plugin-host", { data: { allowWithoutLandlock: true } });
  }

  await installSigned(
    owner,
    BACNET.id,
    dataSourcePackage(
      BACNET.id,
      BACNET.name,
      "Reads chillers, air handlers and meters from a BACnet/IP building management system.",
      47808,
    ),
  );
  await installSigned(owner, KPI, kpiPackage());
  const bacnet = await owner.createSource("Chiller plant (BACnet)", BACNET.id, {
    host: "bms.basalt.example",
  });
  // One query starts the process, so the pages show it running in its sandbox.
  await owner.context.post(`/api/orgs/${owner.orgId}/query`, {
    data: {
      queries: [{ refId: "A", datasourceId: bacnet, query: { do: "frame" } }],
      timeRange: { from: GALLERY_NOW - HOUR, to: GALLERY_NOW },
    },
  });

  return owner.createDashboard({
    schemaVersion: 2,
    title: PLUGIN_PANELS,
    timeRange: { from: "now-24h", to: "now" },
    variables: [],
    panels: [
      kpiPanel(
        sql,
        "it",
        "IT load, kW",
        0,
        "SELECT ts AS time, ROUND(SUM(power_w) / 1000.0, 1) AS kW FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { field: "kW", decimals: 1 },
      ),
      kpiPanel(
        sql,
        "pue",
        "PUE, whole site",
        6,
        "SELECT ts AS time, SUM(facility_w) * 1.0 / SUM(it_w) AS PUE FROM hall_power WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { field: "PUE", decimals: 2 },
      ),
      kpiPanel(
        sql,
        "inlet",
        "Hottest rack inlet, °C",
        12,
        "SELECT ts AS time, MAX(inlet_c) AS inlet FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { field: "inlet", decimals: 1 },
      ),
      kpiPanel(
        sql,
        "network",
        "Network, Gbit/s",
        18,
        "SELECT ts AS time, SUM(ingress_bps + egress_bps) / 1e9 AS gbps FROM network WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts",
        { field: "gbps", decimals: 1 },
      ),
      {
        id: "power",
        type: "timeseries",
        title: "IT power per hall",
        grid: { x: 0, y: 6, w: 24, h: 12 },
        targets: sqlTarget(sql, PER_HALL_POWER),
        options: {},
        fieldConfig: { defaults: { unit: "watt", fillOpacity: 12 }, overrides: [] },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// The scenes.

test("setup, then the example data", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  for (const scheme of SCHEMES) {
    const page = await openPage(browser, scheme);
    // The account step: checking the code only confirms it, setup completes below.
    await page.goto("/setup");
    await page
      .getByLabel(t("access.setup.code.label"))
      .fill(process.env.KALZIT_E2E_SETUP_TOKEN ?? "");
    await page.getByRole("button", { name: t("access.next") }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: t("access.setup.account.title") }),
    ).toBeVisible();
    await page.getByLabel(t("access.setup.account.name")).fill(OWNER.name);
    await page.getByLabel(t("access.setup.account.email")).fill(OWNER.email);
    await shoot(page, `setup-${scheme}`);
    await page.context().close();
  }
  await Api.setup({ token: process.env.KALZIT_E2E_SETUP_TOKEN ?? "", ...OWNER });
  writeFileSync(seededFile(), JSON.stringify(await seed()));
});

for (const scheme of SCHEMES) {
  test(`sign-in, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: t("access.login.title") })).toBeVisible();
    await page.getByLabel(t("access.login.email")).fill(OWNER.email);
    await shoot(page, `sign-in-${scheme}`);
    await page.context().close();
  });
}

async function overviewReady(page: Page): Promise<void> {
  await openDashboard(page, seeded().overview, OVERVIEW);
  await expect(page.locator(".uplot")).toHaveCount(2);
  await expect(page.locator(".stat")).toHaveCount(4);
  await expect(card(page, "Racks with the highest power draw").getByRole("table")).toBeVisible();
  await noEmptyPanels(page);
}

for (const scheme of SCHEMES) {
  test(`overview dashboard, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await overviewReady(page);
    await shoot(page, `dashboard-overview-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`graph network, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().topology, TOPOLOGY);
    await graphDrawn(card(page, TOPOLOGY_PANEL), TOPOLOGY_PANEL);
    await noEmptyPanels(page);
    await shoot(page, `graph-network-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`graph network with the node inspector, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().topology, TOPOLOGY);
    const panel = card(page, TOPOLOGY_PANEL);
    await selectNode(panel, TOPOLOGY_PANEL, "srv-b1-01-1");
    await showDrawing(panel, TOPOLOGY_PANEL);
    await expect(
      panel.getByRole("region", { name: t("graph.details", { name: "srv-b1-01-1" }) }),
    ).toBeVisible();
    await noEmptyPanels(page);
    await shoot(page, `graph-inspector-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`graph hierarchy and paths, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().graphViews, GRAPH_VIEWS);
    await graphDrawn(card(page, PANEL.hierarchy), PANEL.hierarchy);
    await expect(
      card(page, PANEL.network).getByRole("heading", {
        name: t("graph.path.title", { number: 1, count: 3 }),
      }),
    ).toBeVisible();
    await expect(
      card(page, PANEL.power).getByRole("heading", {
        name: t("graph.path.title", { number: 1, count: 4 }),
      }),
    ).toBeVisible();
    await noEmptyPanels(page);
    await shoot(page, `graph-hierarchy-paths-${scheme}`);
    await page.context().close();
  });
}

/** Loads the neighbours of a node in explorer mode, from the node's row in the panel's table. */
async function expand(around: Locator, node: string): Promise<void> {
  // The node's row in the table of nodes; the details list it among the neighbours too.
  await around
    .getByRole("table", { name: /./ })
    .first()
    .getByRole("button", { name: node, exact: true })
    .click();
  // The click loads the neighbours at once once the panel knows the source may be queried;
  // before that it only selects, and the details offer the same action.
  const steps = around.getByRole("region", { name: t("graph.steps.title"), exact: true });
  const step = steps.getByRole("button", { name: new RegExp(`^${node} \\+`) });
  const load = around.getByRole("button", { name: t("graph.explorer.expand"), exact: true });
  await expect(step.or(load).first()).toBeVisible();
  if (!(await step.isVisible()) && (await load.isEnabled())) await load.click();
  await expect(step).toBeVisible();
}

for (const scheme of SCHEMES) {
  test(`graph explorer mid-expansion, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().explorer, EXPLORER);
    // From a spine switch to its leaves and cores, then from one leaf to its rack and servers.
    const around = card(page, PANEL.explorer);
    await graphDrawn(around, PANEL.explorer);
    await around.getByRole("button", { name: t("graph.showTable"), exact: true }).click();
    await expand(around, "spine-a1");
    await expand(around, "leaf-a1-01");
    await showDrawing(around, PANEL.explorer);
    await noEmptyPanels(page);
    await shoot(page, `graph-explorer-${scheme}`);
    await page.context().close();
  });
}

/** Opens the first document of a tree and some of its nested fields. */
async function openDocument(tree: Locator, fields: string[]): Promise<void> {
  await tree
    .getByRole("treeitem", { name: /^Document 1\b/ })
    .first()
    .click();
  for (const field of fields) {
    await tree
      .getByRole("treeitem", { name: new RegExp(`^${field}\\b`) })
      .first()
      .click();
  }
  // A click also opens the menu of the value (copy its path); the picture shows the tree alone,
  // scrolled back to its first document.
  await tree.page().keyboard.press("Escape");
  await tree.evaluate((element) => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      node.scrollTop = 0;
    }
  });
}

for (const scheme of SCHEMES) {
  test(`MongoDB pipeline with a stage preview, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto(`/explore?analysis=${seeded().pipeline}`);
    await expect(page.getByRole("heading", { name: PIPELINE })).toBeVisible();
    const result = page.getByRole("region", { name: t("explore.result") });
    await expect(result.getByRole("tree").first()).toBeVisible();
    await page
      .getByRole("button", { name: t("documents.pipeline.preview", { number: 1 }) })
      .click();
    const preview = page.getByRole("region", {
      name: t("documents.pipeline.previewOf", { number: 1 }),
    });
    await expect(preview).toBeVisible();
    await expect(preview.locator('[aria-busy="true"]')).toHaveCount(0);
    await openDocument(preview.getByRole("tree").first(), ["location"]);
    await shoot(page, `documents-pipeline-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`documents dashboard, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().documents, DOCUMENTS);
    const incidents = card(page, "Incidents, newest first").getByRole("tree").first();
    await expect(incidents).toBeVisible();
    await openDocument(incidents, ["source", "measurement", "timeline"]);
    await expect(card(page, "Fields of the asset records")).toContainText("hardware");
    await noEmptyPanels(page);
    await shoot(page, `documents-dashboard-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`explore, saved analysis with steps, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto(`/explore?analysis=${seeded().steps}`);
    await expect(page.getByRole("heading", { name: STEPS })).toBeVisible();
    const result = page.getByRole("region", { name: t("explore.result") }).first();
    await expect(result.locator(".uplot")).toBeVisible();
    await expect(result).toHaveAttribute("aria-busy", "false");
    await shoot(page, `explore-steps-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`all sources dashboard, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().allSources, ALL_SOURCES);
    await expect(page.locator(".uplot")).toHaveCount(1);
    await graphDrawn(
      card(page, "Power chain from grid to racks (Neo4j)"),
      "Power chain from grid to racks (Neo4j)",
    );
    await noEmptyPanels(page);
    await shoot(page, `dashboard-all-sources-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`live dashboard, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().live, LIVE);
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
      card(page, "Inlet temperature per row, Hall B").locator(".panel-card__live"),
    ).toContainText(t("live.every", { interval: "30s" }));
    await expect(page.locator(".uplot")).toHaveCount(1);
    await noEmptyPanels(page);
    await shoot(page, `dashboard-live-${scheme}`);
    await page.context().close();
  });
}

// ---------------------------------------------------------------------------------------------
// AI and plugins.

/** Confirms the first-use notice of a provider when it comes, before `next` shows. */
async function passNotice(page: Page, next: Locator): Promise<void> {
  const notice = page.getByRole("dialog", { name: t("ai.notice.title") });
  await expect(notice.or(next).first()).toBeVisible();
  if (await notice.isVisible()) {
    await notice.getByRole("button", { name: t("ai.notice.confirm") }).click();
    await expect(notice).toBeHidden();
  }
}

async function exploreAnalysis(page: Page): Promise<Locator> {
  await page.goto(`/explore?analysis=${seeded().pue}`);
  await expect(page.getByRole("heading", { name: PUE_TITLE })).toBeVisible();
  const result = page.getByRole("region", { name: t("explore.result") }).first();
  await expect(result.getByRole("table")).toBeVisible();
  await expect(result).toHaveAttribute("aria-busy", "false");
  return result;
}

for (const scheme of SCHEMES) {
  test(`explore, explain a query, ${scheme}`, async ({ browser }) => {
    await ensureAssistant();
    const page = await openPage(browser, scheme);
    await signIn(page);
    await exploreAnalysis(page);
    await page.getByRole("button", { name: t("ai.call.explain"), exact: true }).click();
    const explanation = page.getByRole("region", { name: t("ai.call.explanationTitle") });
    await passNotice(page, explanation);
    await expect(explanation).toContainText("sorted by name");
    await shoot(page, `explore-explain-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`explore, summarize a result, ${scheme}`, async ({ browser }) => {
    await ensureAssistant();
    const page = await openPage(browser, scheme);
    await signIn(page);
    const result = await exploreAnalysis(page);
    await result.getByRole("button", { name: t("ai.call.summarize"), exact: true }).click();
    const summary = page.getByRole("region", { name: t("ai.call.summaryTitleExplore") });
    await passNotice(page, summary);
    await expect(summary).toContainText("kW on average");
    await shoot(page, `explore-summarize-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`ask, an answer with its steps, ${scheme}`, async ({ browser }) => {
    await ensureAssistant();
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto("/ask");
    await page.getByLabel(t("ai.chat.question")).fill(ASK_QUESTION);
    await page.getByRole("button", { name: t("ai.chat.send"), exact: true }).click();
    const answer = page.getByLabel(t("ai.chat.answerLabel"), { exact: true });
    await passNotice(page, page.getByLabel(t("ai.chat.working")).or(answer).first());
    await expect(answer).toContainText("had the highest inlet temperatures");
    await shoot(page, `ask-answer-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`administration, AI, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto("/settings/ai");
    await expect(page.getByText("LiteLLM gateway").first()).toBeVisible();
    await shoot(page, `ai-settings-${scheme}`);
    await page
      .getByRole("heading", { name: t("ai.admin.functions.title") })
      .evaluate((heading) => heading.closest("section")?.scrollIntoView({ block: "center" }));
    await shoot(page, `ai-functions-${scheme}`);
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`administration, plugins, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await page.goto("/settings/plugins");
    await expect(
      page.getByRole("row").filter({ hasText: BACNET.name }).getByText(t("plugins.status.running")),
    ).toBeVisible();
    await shoot(page, `plugins-installed-${scheme}`);

    await page.goto(`/settings/plugins/${BACNET.id}`);
    await expect(page.getByRole("heading", { level: 2, name: BACNET.name })).toBeVisible();
    await shoot(page, `plugin-page-${scheme}`);

    await page.goto("/settings/plugins#trust");
    await expect(page.getByRole("heading", { name: t("plugins.trust.keys.title") })).toBeVisible();
    await expect(page.getByText(PUBLISHER).first()).toBeVisible();
    await shoot(page, `plugins-trust-${scheme}`);

    // Install from file up to the review: the checks passed, the targets to grant. Closing the
    // dialog takes the package back.
    await page.goto("/settings/plugins");
    await page.getByRole("button", { name: t("plugins.install.open") }).click();
    const dialog = page.getByRole("dialog", { name: t("plugins.install.title") });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "modbus-meters-1.0.0.kalzit-plugin",
      mimeType: "application/zip",
      buffer: dataSourcePackage(
        "dev.basalt.modbus",
        "Modbus meters",
        "Reads energy meters and PDUs over Modbus TCP.",
        502,
      ),
    });
    const review = page.getByRole("dialog", {
      name: t("plugins.install.reviewTitle", { name: "Modbus meters", version: "1.0.0" }),
    });
    await expect(review.getByRole("heading", { name: t("plugins.install.checks") })).toBeVisible();
    await shoot(page, `plugin-install-${scheme}`);
    await review.getByRole("button", { name: t("admin.common.cancel"), exact: true }).click();
    await expect(review).toBeHidden();
    await page.waitForLoadState("networkidle");
    await page.context().close();
  });
}

for (const scheme of SCHEMES) {
  test(`dashboard with plugin panels, ${scheme}`, async ({ browser }) => {
    const page = await openPage(browser, scheme);
    await signIn(page);
    await openDashboard(page, seeded().pluginPanels, PLUGIN_PANELS);
    for (const title of [
      "IT load, kW",
      "PUE, whole site",
      "Hottest rack inlet, °C",
      "Network, Gbit/s",
    ]) {
      await expect(
        page
          .frameLocator(`iframe[title="${t("panelPlugins.frameTitle", { name: title })}"]`)
          .locator(".value"),
      ).toBeVisible();
    }
    await expect(page.locator(".uplot")).toHaveCount(1);
    await noEmptyPanels(page);
    await shoot(page, `dashboard-plugin-panel-${scheme}`);
    await page.context().close();
  });
}
