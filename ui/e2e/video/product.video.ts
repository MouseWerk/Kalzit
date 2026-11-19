import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Browser, expect, type Locator, type Page, test } from "@playwright/test";
import { Api, baseUrl, fixturesDir } from "../support/api";
import { pattern, t } from "../support/i18n";
import { selectOption } from "../support/select";
import { boltTarget, GRAPH_FIXTURE } from "../support/services";
import { fillQuery } from "../support/ui";

/**
 * "Kalzit in 60 seconds": one take on an empty Kalzit, recorded at 1920 x 1080 for the
 * social video (.github/workflows/gallery.yml, set `video`; docs/screenshots/README.md).
 *
 *   0-8 s    Data sources > Add > Neo4j
 *   8-18 s   the connection typed in, Test connection, Add data source
 *   18-30 s  Explore: a Cypher query, the result as a graph, a click on a node for its details
 *   30-45 s  added to a new dashboard, which then holds a table and a time series beside it
 *   45-60 s  the dashboard hovered (a node, a table row, the time series), the closing card
 *
 * The captions and the pointer are drawn by this file into the page (an overlay outside the
 * product, see installOverlay): a recording shows no system pointer. Every wait is on something
 * the page shows; the fixed pauses only set the pace. The data is the shop graph of the e2e
 * services (e2e/fixtures/graph-shop.cypher) and the sales file of global-setup.ts, all invented.
 * The workflow cuts the recording to what lies between the marks this file writes.
 */

const OUT = resolve(
  process.env.KALZIT_VIDEO_OUT ?? join(import.meta.dirname, "..", ".output", "video"),
);

const OWNER = {
  name: "Maria Keller",
  email: "maria.keller@kalzit.test",
  password: "video-password-maria",
  orgName: "Sunstone Shop",
} as const;

const SIZE = { width: 1920, height: 1080 } as const;

const SOURCE = "Shop graph";
const SALES_SOURCE = "Shop sales";
const DASHBOARD = "Shop at a glance";
const PANELS = {
  graph: "Customers, orders and products",
  table: "Orders per customer",
  series: "Sales per region",
} as const;

/** Customers, their orders and the products in them: typed in Explore. */
const SHOP =
  "MATCH (c:Customer)-[p:PLACED]->(o:Order)-[i:CONTAINS]->(pr:Product) RETURN c, p, o, i, pr";
/** The same customers as rows, for the table panel. */
const ORDERS_PER_CUSTOMER =
  "MATCH (c:Customer)-[:PLACED]->(o:Order) RETURN c.name AS Customer, c.city AS City, count(o) AS Orders, sum(o.total) AS Total ORDER BY Total DESC";
const REGIONS = ["Nord", "Ost", "Süd", "West"] as const;
/** The sales file of global-setup.ts, one series per region. */
const SALES_PER_REGION = `SELECT ts AS time, ${REGIONS.map(
  (region) => `SUM(CASE WHEN region = '${region}' THEN amount END) AS "${region}"`,
).join(", ")} FROM sales WHERE $__timeFilter(ts) GROUP BY ts ORDER BY ts`;

const CAPTIONS = {
  connect: "Connect Neo4j",
  test: "Test the connection, then add it",
  query: "Ask in Cypher",
  graph: "Your Cypher result stays a graph",
  details: "Click a node for its details",
  dashboard: "Add it to a new dashboard",
  together: "Graph, table and time series on one dashboard",
  closing:
    "Kalzit: self-hosted, open source (AGPL), Windows and Linux · github.com/MouseWerk/Kalzit",
} as const;

/** What a Sigma canvas offers the tests (SigmaCanvas.tsx) when the page asks for the hooks. */
type CanvasHost = HTMLElement & {
  kalzitNodePosition?: (caption: string) => { x: number; y: number } | null;
};

function service(name: string): string {
  const value = process.env[name] ?? "";
  if (value === "") {
    throw new Error(`${name} is not set; the video needs the Neo4j of e2e-services.sh`);
  }
  return value;
}

/**
 * The overlay of the recording, put into every document of the context before the app's own
 * scripts: a pointer that follows the mouse (headless Chromium draws none) and a caption bar at
 * the bottom. Built with DOM calls and inline style properties only, which Kalzit's content
 * security policy allows from a script; both ignore the pointer and are hidden from assistive
 * technology. The caption and the pointer's place outlive a full page load in sessionStorage.
 */
function installOverlay(): void {
  const KEY_CAPTION = "kalzit-video-caption";
  const KEY_POINTER = "kalzit-video-pointer";
  const SVG = "http://www.w3.org/2000/svg";
  type Overlay = { caption: (text: string, card: boolean) => void };
  const w = window as unknown as { kalzitVideo?: Overlay };

  const read = (key: string): string | null => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // The overlay works without it; only a reload forgets the place.
    }
  };
  const style = (element: HTMLElement | SVGElement, properties: Record<string, string>) => {
    for (const [name, value] of Object.entries(properties)) {
      element.style.setProperty(name, value);
    }
  };

  const build = () => {
    const root = document.body;
    if (root === null || document.getElementById("kalzit-video-pointer") !== null) return;

    const pointer = document.createElement("div");
    pointer.id = "kalzit-video-pointer";
    pointer.setAttribute("aria-hidden", "true");
    style(pointer, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "28px",
      height: "28px",
      "pointer-events": "none",
      "z-index": "2147483647",
      "transform-origin": "4px 3px",
      transition: "scale 120ms ease-out",
    });
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 28 28");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "28");
    const arrow = document.createElementNS(SVG, "path");
    arrow.setAttribute("d", "M4 3 L4 23 L9.5 17.5 L13 25.5 L16.5 24 L13 16 L21 16 Z");
    arrow.setAttribute("fill", "#ffffff");
    arrow.setAttribute("stroke", "#111111");
    arrow.setAttribute("stroke-width", "1.6");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.append(arrow);
    pointer.append(svg);
    const place = (x: number, y: number) => {
      style(pointer, { translate: `${x - 4}px ${y - 3}px` });
    };
    const saved = read(KEY_POINTER)?.split(",").map(Number);
    place(saved?.[0] ?? innerWidth / 2, saved?.[1] ?? innerHeight / 2);
    addEventListener(
      "mousemove",
      (event) => {
        place(event.clientX, event.clientY);
        write(KEY_POINTER, `${event.clientX},${event.clientY}`);
      },
      { capture: true, passive: true },
    );
    addEventListener("mousedown", () => style(pointer, { scale: "0.82" }), { capture: true });
    addEventListener("mouseup", () => style(pointer, { scale: "1" }), { capture: true });

    const bar = document.createElement("div");
    bar.id = "kalzit-video-caption";
    bar.setAttribute("aria-hidden", "true");
    style(bar, {
      position: "fixed",
      left: "50%",
      bottom: "56px",
      translate: "-50% 0",
      "max-width": "1500px",
      padding: "16px 32px",
      "border-radius": "12px",
      background: "rgba(10, 12, 16, 0.78)",
      color: "#ffffff",
      "font-family": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      "font-size": "36px",
      "font-weight": "500",
      "line-height": "1.3",
      "text-align": "center",
      "pointer-events": "none",
      "z-index": "2147483646",
      opacity: "0",
      transition: "opacity 300ms ease-out",
    });
    const shade = document.createElement("div");
    shade.id = "kalzit-video-shade";
    shade.setAttribute("aria-hidden", "true");
    style(shade, {
      position: "fixed",
      inset: "0",
      background: "rgba(10, 12, 16, 0.72)",
      "pointer-events": "none",
      "z-index": "2147483645",
      opacity: "0",
      transition: "opacity 500ms ease-out",
    });
    root.append(shade, bar, pointer);

    const caption = (text: string, card: boolean) => {
      write(KEY_CAPTION, JSON.stringify({ text, card }));
      bar.textContent = text;
      style(bar, {
        opacity: text === "" ? "0" : "1",
        bottom: card ? "50%" : "56px",
        translate: card ? "-50% 50%" : "-50% 0",
        "font-size": card ? "44px" : "36px",
        padding: card ? "32px 48px" : "16px 32px",
      });
      style(shade, { opacity: card ? "1" : "0" });
    };
    w.kalzitVideo = { caption };
    const kept = read(KEY_CAPTION);
    if (kept !== null) {
      const { text, card } = JSON.parse(kept) as { text: string; card: boolean };
      caption(text, card);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build, { once: true });
  } else {
    build();
  }
}

/** Shows a caption at the bottom (or, as the closing card, in the middle); "" hides it. */
async function caption(page: Page, text: string, card = false): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ([value, asCard]) => {
          const overlay = (
            window as unknown as {
              kalzitVideo?: { caption: (text: string, card: boolean) => void };
            }
          ).kalzitVideo;
          overlay?.caption(value, asCard);
          return overlay !== undefined;
        },
        [text, card] as const,
      ),
    )
    .toBe(true);
}

/** A pause for the viewer, not for the page: everything waited on is checked separately. */
function hold(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

/** Where the pointer is, kept here: Playwright does not say. */
const pointer = { x: SIZE.width / 2, y: SIZE.height / 2 };

/** Moves the pointer to a point in a calm, eased glide, so the viewer can follow it. */
async function glideTo(page: Page, x: number, y: number): Promise<void> {
  const from = { ...pointer };
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(8, Math.min(40, Math.round(distance / 22)));
  for (let step = 1; step <= steps; step++) {
    const p = step / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
    await page.waitForTimeout(14);
  }
  pointer.x = x;
  pointer.y = y;
}

/** Glides to the middle of an element (scrolled into view first). */
async function glide(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error("the element to point at is not on screen");
  await glideTo(target.page(), box.x + box.width / 2, box.y + box.height / 2);
}

/** Glides to an element and clicks it where the pointer is. */
async function click(target: Locator): Promise<void> {
  await glide(target);
  await hold(target.page(), 180);
  await target.click();
}

/** Glides to a field, clicks it and types like a person, at a readable pace. */
async function type(target: Locator, text: string): Promise<void> {
  await click(target);
  await target.press("ControlOrMeta+A");
  await target.pressSequentially(text, { delay: 55 });
  await expect(target).toHaveValue(text);
}

/**
 * Types a query into the editor key by key. The editor closes brackets and quotes as it goes;
 * if what stands there differs from the query in the end, the query is put in as a whole.
 */
async function typeQuery(page: Page, query: string): Promise<void> {
  const editor = page.locator(".cm-content").first();
  await click(editor);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(query, { delay: 28 });
  // The completions typing opened, closed as a person would before moving on.
  await page.keyboard.press("Escape");
  if ((await editor.textContent()) !== query) {
    await fillQuery(page, query);
    await page.keyboard.press("Escape");
  }
  await expect(editor).toHaveText(query);
}

/**
 * Where a graph's drawing shows a node, from the canvas' test hook, once the layout has settled:
 * the same place twice in a row (as in graph.spec.ts).
 */
async function drawnNode(scope: Locator, name: string): Promise<{ x: number; y: number }> {
  const canvas = scope.locator(".graph__canvas");
  let last: { x: number; y: number } | null = null;
  for (let tries = 0; tries < 80; tries++) {
    const now = await canvas.evaluate(
      (element, caption) => (element as CanvasHost).kalzitNodePosition?.(caption) ?? null,
      name,
    );
    if (
      now !== null &&
      last !== null &&
      Math.abs(now.x - last.x) + Math.abs(now.y - last.y) < 0.5
    ) {
      return now;
    }
    last = now;
    await scope.page().waitForTimeout(250);
  }
  throw new Error(`${name} is not drawn`);
}

/** Waits until a graph has been drawn and its layout has settled. */
async function graphDrawn(scope: Locator, title: string): Promise<void> {
  await expect(scope.getByRole("application", { name: title, exact: true })).toBeVisible();
  await expect(scope.getByText(t("graph.layout.settling"))).toHaveCount(0);
}

/** Signs the owner in outside the recording and answers the session for the recorded context. */
async function signedInState(browser: Browser) {
  const context = await browser.newContext({ baseURL: baseUrl(), locale: "en-US" });
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByLabel(t("access.login.email")).fill(OWNER.email);
    await page.getByLabel(t("access.login.password"), { exact: true }).fill(OWNER.password);
    await page.getByRole("button", { name: t("access.login.submit") }).click();
    await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
    // Tips show once and at their own moment; the video shows the product without them.
    const answer = await page.request.patch("/api/me/preferences", { data: { showTips: false } });
    expect(answer.ok(), await answer.text()).toBe(true);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

interface StoredDashboard {
  version: number;
  model: { panels: Record<string, unknown>[] } & Record<string, unknown>;
}

/**
 * The second and third panel, beside the graph that Explore added: a table of the same Neo4j
 * source and a time series of the sales file, laid out side by side for 1920 x 1080.
 */
async function addTableAndSeries(dashboardId: string, neo4jId: string): Promise<void> {
  const owner = await Api.signIn(OWNER.email, OWNER.password);
  try {
    const salesId = await owner.createSqliteSource(SALES_SOURCE, join(fixturesDir(), "sales.db"));
    const path = `/api/orgs/${owner.orgId}/dashboards/${dashboardId}`;
    const got = await owner.context.get(path);
    expect(got.ok(), await got.text()).toBe(true);
    const stored = (await got.json()) as StoredDashboard;
    const [graph] = stored.model.panels;
    if (graph === undefined) throw new Error("the dashboard has no panel from Explore");
    const saved = await owner.context.put(path, {
      data: {
        version: stored.version,
        model: {
          ...stored.model,
          timeRange: { from: "now-6h", to: "now" },
          panels: [
            { ...graph, title: PANELS.graph, grid: { x: 0, y: 0, w: 11, h: 24 } },
            {
              id: "orders",
              type: "table",
              title: PANELS.table,
              grid: { x: 11, y: 0, w: 13, h: 10 },
              targets: [
                { refId: "A", datasourceId: neo4jId, query: { cypher: ORDERS_PER_CUSTOMER } },
              ],
              options: {},
            },
            {
              id: "sales",
              type: "timeseries",
              title: PANELS.series,
              grid: { x: 11, y: 10, w: 13, h: 14 },
              targets: [{ refId: "A", datasourceId: salesId, query: { sql: SALES_PER_REGION } }],
              options: {},
              fieldConfig: { defaults: { fillOpacity: 10 }, overrides: [] },
            },
          ],
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
  } finally {
    await owner.dispose();
  }
}

/** The id of the data source the page shows, from its address (/data-sources/<id>). */
function sourceIdOf(page: Page): string {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (id === undefined || id === "new") throw new Error(`no data source in ${page.url()}`);
  return id;
}

/** The id of the dashboard the page shows, from its address (/dashboards/<id>). */
function dashboardIdOf(page: Page): string {
  const match = /\/dashboards\/([^/?#]+)/.exec(page.url());
  if (match?.[1] === undefined) throw new Error(`no dashboard in ${page.url()}`);
  return match[1];
}

test("Kalzit in 60 seconds", async ({ browser }) => {
  const bolt = boltTarget(service("KALZIT_E2E_NEO4J"));
  mkdirSync(OUT, { recursive: true });
  await Api.setup({ token: process.env.KALZIT_E2E_SETUP_TOKEN ?? "", ...OWNER });
  const storageState = await signedInState(browser);

  const context = await browser.newContext({
    baseURL: baseUrl(),
    storageState,
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme: "dark",
    recordVideo: { dir: join(OUT, "raw"), size: SIZE },
  });
  await context.addInitScript(installOverlay);
  // The canvas says where it draws a node only to pages that ask for the test hooks.
  await context.addInitScript(() => {
    (window as { __kalzitTestHooks?: boolean }).__kalzitTestHooks = true;
  });
  const page = await context.newPage();
  const recordingStarted = Date.now();
  const video = page.video();
  if (video === null) throw new Error("the context records no video");
  const nav = page.getByRole("navigation", { name: t("nav.label") });
  let cut = { start: 0, end: 0 };

  try {
    // ---- 0-8 s: an empty Kalzit, signed in; Data sources > Add > Neo4j.
    await page.goto("/");
    await expect(nav).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(pointer.x, pointer.y);
    cut = { ...cut, start: Date.now() - recordingStarted };
    await caption(page, CAPTIONS.connect);
    await hold(page, 1200);
    await click(nav.getByRole("link", { name: t("datasources.nav"), exact: true }));
    await hold(page, 600);
    await click(page.getByRole("link", { name: t("datasources.add") }).first());
    const neo4j = page.getByRole("link", { name: "Neo4j" }).first();
    await expect(neo4j).toBeVisible();
    await hold(page, 500);
    await click(neo4j);
    const form = page.locator("form.ds-form");
    await expect(
      form.getByRole("heading", { name: t("datasources.new.connect", { kind: "Neo4j" }) }),
    ).toBeVisible();
    await hold(page, 500);

    // ---- 8-18 s: the connection, the test, the source added.
    await type(form.getByLabel(t("datasources.form.name"), { exact: true }), SOURCE);
    await type(form.getByLabel(t("datasources.settings.host"), { exact: true }), bolt.host);
    await type(
      form.getByLabel(t("datasources.form.optional", { label: t("datasources.settings.port") }), {
        exact: true,
      }),
      String(bolt.port),
    );
    await type(
      form.getByLabel(t("datasources.form.optional", { label: t("datasources.settings.user") }), {
        exact: true,
      }),
      GRAPH_FIXTURE.neo4jUser,
    );
    await type(
      form.getByLabel(
        t("datasources.form.optional", { label: t("datasources.settings.password") }),
        {
          exact: true,
        },
      ),
      GRAPH_FIXTURE.neo4jPassword,
    );
    await caption(page, CAPTIONS.test);
    await click(form.getByRole("button", { name: t("datasources.health.test"), exact: true }));
    await expect(form.locator(".ds-health-region")).toContainText(pattern("datasources.health.ok"));
    await hold(page, 1400);
    await click(form.getByRole("button", { name: t("datasources.form.create"), exact: true }));
    await expect(page.getByRole("heading", { level: 1, name: SOURCE, exact: true })).toBeVisible();
    const neo4jId = sourceIdOf(page);
    await hold(page, 900);

    // ---- 18-30 s: Explore, a Cypher query, the result as a graph, a node's details.
    await caption(page, CAPTIONS.query);
    await click(nav.getByRole("link", { name: t("explore.nav"), exact: true }));
    const datasource = page.getByLabel(t("explore.datasource"));
    await glide(datasource);
    await selectOption(datasource, { label: SOURCE });
    await typeQuery(page, SHOP);
    await click(page.getByRole("button", { name: t("explore.run") }));
    const result = page.getByRole("region", { name: t("explore.result") });
    await graphDrawn(result, t("explore.result"));
    await caption(page, CAPTIONS.graph);
    const ana = await drawnNode(result, "Ana");
    await hold(page, 1200);
    await caption(page, CAPTIONS.details);
    await glideTo(page, ana.x, ana.y);
    await hold(page, 250);
    await page.mouse.click(ana.x, ana.y);
    await expect(
      page.getByRole("region", { name: t("graph.details", { name: "Ana" }), exact: true }),
    ).toBeVisible();
    await hold(page, 2200);

    // ---- 30-45 s: into a new dashboard, with a table and a time series beside the graph.
    await caption(page, CAPTIONS.dashboard);
    await click(
      page
        .getByRole("complementary", { name: t("explore.aside") })
        .getByRole("button", { name: t("explore.addToDashboard") }),
    );
    const add = page.getByRole("dialog", { name: t("explore.add.title") });
    await click(add.getByLabel(t("explore.add.new")));
    await expect(add.getByLabel(t("explore.add.new"))).toBeChecked();
    await type(add.getByLabel(t("dashboards.new.titleLabel")), DASHBOARD);
    await hold(page, 400);
    await click(add.getByRole("button", { name: t("explore.add.submit") }));
    await expect(page.getByRole("heading", { name: DASHBOARD, exact: true })).toBeVisible();
    await hold(page, 1500);
    await addTableAndSeries(dashboardIdOf(page), neo4jId);
    await page.reload();
    const card = (title: string) => page.getByRole("article", { name: title, exact: true });
    await expect(page.getByRole("heading", { name: DASHBOARD, exact: true })).toBeVisible();
    await caption(page, CAPTIONS.together);
    const graphCard = card(PANELS.graph);
    const tableCard = card(PANELS.table);
    const seriesCard = card(PANELS.series);
    await graphDrawn(graphCard, PANELS.graph);
    await expect(tableCard.getByRole("table")).toBeVisible();
    await expect(tableCard.getByRole("cell", { name: "Clara", exact: true })).toBeVisible();
    await expect(seriesCard.locator(".ts__plot")).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await hold(page, 2500);

    // ---- 45-60 s: the dashboard hovered, then the closing card.
    const clara = await drawnNode(graphCard, "Clara");
    await glideTo(page, clara.x, clara.y);
    await hold(page, 1800);
    const row = tableCard.getByRole("row").nth(1);
    await glide(row);
    await hold(page, 1600);
    const plot = seriesCard.locator(".ts__plot");
    const box = await plot.boundingBox();
    if (box === null) throw new Error("the time series is not on screen");
    await glideTo(page, box.x + box.width * 0.45, box.y + box.height * 0.5);
    await expect(page.locator(".ts__tooltip[data-placed]")).toBeVisible();
    await glideTo(page, box.x + box.width * 0.7, box.y + box.height * 0.45);
    await hold(page, 1800);
    await caption(page, CAPTIONS.closing, true);
    await hold(page, 3000);
    cut = { ...cut, end: Date.now() - recordingStarted };
  } finally {
    await context.close();
    await video.saveAs(join(OUT, "kalzit-in-60-seconds.webm"));
    // Where the take begins and ends in the recording, for the cut (in seconds).
    writeFileSync(
      join(OUT, "cut.json"),
      `${JSON.stringify({ start: cut.start / 1000, end: cut.end / 1000 })}\n`,
    );
  }
  expect(cut.end, "the take reached its closing card").toBeGreaterThan(cut.start);
});
