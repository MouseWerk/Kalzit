import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// The map panel and Verwaltung > Karte against the real server (board Graph081.dc.html, frames
// 15 to 17): without map images the panel draws the bundled outlines; with a source the server
// fetches the images from a map service on this machine, and the browser only ever asks Kalzit.

/** A 1x1 PNG, as a map service would answer every image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function startTiles(): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(PNG);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

/** Switches the map images off again: the setting is the whole server's. */
async function switchOff(owner: Api): Promise<void> {
  const view = (await (await owner.context.get("/api/admin/map")).json()) as { version: number };
  await owner.context.put("/api/admin/map/enabled", {
    data: { enabled: false, version: view.version },
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

// One server setting for all: these steps run one after the other.
test.describe.configure({ mode: "serial" });

test("draws places over the outlines, then map images that come only through Kalzit", async ({
  page,
}) => {
  const owner = await Api.owner();
  const tiles = await startTiles();
  try {
    const sourceId = await owner.createSqliteSource(
      unique("Lager"),
      join(fixturesDir(), "sales.db"),
    );
    const title = unique("Lieferwege");
    const dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title,
      timeRange: { from: "now-6h", to: "now" },
      panels: [
        {
          id: "m1",
          type: "map",
          title: "Lager",
          grid: { x: 0, y: 0, w: 24, h: 12 },
          options: { coords: "latLon", latField: "lat", lonField: "lon" },
          targets: [
            {
              refId: "A",
              datasourceId: sourceId,
              query: {
                sql:
                  "SELECT 'Lager Nord' AS name, 53.55 AS lat, 9.99 AS lon " +
                  "UNION ALL SELECT 'Lager Süd', 48.14, 11.58 " +
                  "UNION ALL SELECT 'Petra Lang', NULL, NULL",
              },
            },
          ],
        },
      ],
    });
    const foreign: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`:${tiles.port}`)) foreign.push(request.url());
    });

    await signInOwner(page, "en");
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByText(/2 of 3 rows on the map\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Lager Nord" })).toBeVisible();
    await expect(page.getByTestId("map-outlines")).toBeVisible();
    await expect(page.getByText(t("map.missing.label"), { exact: true })).toBeVisible();

    // Verwaltung > Karte: off after installation; switching on opens one form with one Save.
    await page.goto("/settings/map");
    const toggle = page.getByRole("switch", { name: t("map.admin.images") });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    const form = page.getByRole("form", { name: t("map.admin.images") });
    await form
      .getByRole("textbox", { name: t("map.admin.url") })
      .fill(`http://127.0.0.1:${tiles.port}/{z}/{x}/{y}.png`);
    await form.getByRole("textbox", { name: t("map.admin.attribution") }).fill("© Testkarten");
    await form.getByRole("button", { name: t("map.admin.test") }).click();
    await expect(form.getByText(/Map image 6\/33\/21 loaded/)).toBeVisible();
    await form.getByRole("button", { name: t("map.admin.save") }).click();
    await expect(page.getByText(t("map.admin.saved"))).toBeVisible();

    await page.goto(`/dashboards/${dashboardId}`);
    const images = page.getByTestId("map-tiles").locator("image");
    await expect(images.first()).toBeAttached();
    expect(await images.first().getAttribute("href")).toMatch(/\/api\/map\/tiles\/\d+\/\d+\/\d+$/);
    await expect(page.getByText("© Testkarten")).toBeVisible();
    await expect.poll(() => tiles.hits.length).toBeGreaterThan(1);
    // The browser never talked to the map service itself.
    expect(foreign).toEqual([]);

    // Off applies at once: the dashboard draws the outlines again.
    await page.goto("/settings/map");
    await page.getByRole("switch", { name: t("map.admin.images") }).click();
    await expect(page.getByText(t("map.admin.switchedOff"))).toBeVisible();
    await page.goto(`/dashboards/${dashboardId}`);
    await expect(page.getByTestId("map-outlines")).toBeVisible();
    await expect(page.getByTestId("map-tiles")).toHaveCount(0);
  } finally {
    await switchOff(owner);
    await owner.dispose();
    tiles.server.close();
  }
});
