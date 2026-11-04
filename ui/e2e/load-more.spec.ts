import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

function filesDir(): string {
  const dir = process.env.KALZIT_E2E_FILES;
  if (dir === undefined || dir === "") {
    throw new Error("KALZIT_E2E_FILES is not set; run the suite through playwright.config.ts");
  }
  return dir;
}

test("a viewer loads more documents of a dashboard's stored query, and only with own cursors", async ({
  pageAs,
}) => {
  const path = join(filesDir(), `${unique("orders").replace(/[^\w-]+/g, "-")}.ndjson`);
  const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ order: i + 1, city: "Graz" }));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  const owner = await Api.owner();
  let dashboardId: string;
  let viewer: { email: string; password: string };
  try {
    // Two documents per page, so the five lines take three pages.
    const sourceId = await owner.createSource(unique("Bestellungen"), "file", {
      path,
      format: "ndjson",
      maxRows: 2,
    });
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Bestellungen"),
      timeRange: { from: "now-1h", to: "now" },
      panels: [
        {
          id: "p1",
          type: "documents",
          title: "Orders",
          grid: { x: 0, y: 0, w: 12, h: 10 },
          targets: [{ refId: "A", datasourceId: sourceId, query: {} }],
        },
      ],
    });
    viewer = await owner.createMember(unique("Vera Viewer"), "viewer");
  } finally {
    await owner.dispose();
  }

  const page = await pageAs(viewer.email, viewer.password);
  await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
  const panel = page.getByRole("article", { name: "Orders", exact: true });
  const count = (n: number) => t("documents.summary.countMany", { count: n });
  const more = panel.getByRole("button", { name: t("documents.more.load"), exact: true });

  await test.step("the first page says the source has more", async () => {
    await expect(panel).toContainText(count(2), { timeout: STEP_MS });
    await expect(panel).toContainText(t("documents.summary.more"), { timeout: STEP_MS });
  });

  let cursor = "";
  await test.step("load more continues through the panel route and appends", async () => {
    const answer = page.waitForResponse((r) => r.url().includes(`/panels/p1/query`));
    await more.click({ timeout: STEP_MS });
    const request = (await answer).request().postDataJSON() as { cursors: Record<string, string> };
    cursor = request.cursors.A ?? "";
    expect(cursor).not.toBe("");
    await expect(panel).toContainText(count(4), { timeout: STEP_MS });
    await more.click({ timeout: STEP_MS });
    await expect(panel).toContainText(count(5), { timeout: STEP_MS });
    await expect(more).toHaveCount(0);
  });

  await test.step("a changed cursor is refused by the server", async () => {
    const [version, , mac] = cursor.split(".");
    const forged = `${version}.${Buffer.from("0").toString("base64url")}.${mac}`;
    const now = Date.now();
    const answer = await page.request.post(
      `/api/orgs/${owner.orgId}/dashboards/${dashboardId}/panels/p1/query`,
      { data: { timeRange: { from: now - 3_600_000, to: now }, cursors: { A: forged } } },
    );
    expect(answer.status()).toBe(200);
    const body = (await answer.json()) as {
      results: Record<string, { error?: { reason?: string } }>;
    };
    expect(body.results.A?.error?.reason).toBe("query.cursor_invalid");
  });
});
