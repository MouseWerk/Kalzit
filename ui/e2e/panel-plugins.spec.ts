import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "./support/api";
import { t } from "./support/i18n";
import { zip } from "./support/plugin";
import { expect, signInOwner, test } from "./support/test";

/**
 * A panel plugin end to end, with the bundle of the example panel plugin
 * (examples/plugins/panel-kpi): signed with a publisher key the test trusts, installed, approved
 * and enabled through the API, then drawn on a dashboard in its sandboxed frame from the query's
 * results, and offered in the panel editor with an options editor built from its manifest.
 */
const BUNDLE = readFileSync(
  join(import.meta.dirname, "..", "..", "examples", "plugins", "panel-kpi", "panel.js"),
);
const NAME = "E2E KPI tile";
const PUBLISHER = "Kalzit E2E";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A panel package of the example's bundle, signed with `key`, and its id. */
function panelPackage(id: string, key: KeyObject) {
  const manifest = [
    "manifest = 1",
    `id = "${id}"`,
    `name = "${NAME}"`,
    'version = "1.0.0"',
    'kind = "panel"',
    `publisher = "${PUBLISHER}"`,
    'min_kalzit = "0.1.0"',
    'shapes = ["frame"]',
    "",
    "[panel]",
    'path = "panel.js"',
    "api = 1",
    "",
    "[[panel.options]]",
    'name = "field"',
    'label = { en = "Field", de = "Feld" }',
    'type = "string"',
    "",
    "[[panel.options]]",
    'name = "decimals"',
    'label = { en = "Decimals", de = "Nachkommastellen" }',
    'type = "integer"',
    "min = 0",
    "max = 10",
    "",
    "[files]",
    `"panel.js" = "${sha256(BUNDLE)}"`,
    "",
  ].join("\n");
  const text = new TextEncoder().encode(manifest);
  const message = Buffer.concat([Buffer.from("kalzit-plugin-manifest-v1\n"), text]);
  return zip([
    { name: "kalzit-plugin.toml", data: text },
    {
      name: "kalzit-plugin.sig",
      data: new TextEncoder().encode(
        JSON.stringify({ keyId: KEY_ID, signature: sign(null, message, key).toString("base64") }),
      ),
    },
    { name: "panel.js", data: new Uint8Array(BUNDLE) },
  ]);
}

const keys = generateKeyPairSync("ed25519");
const PUBLIC = Buffer.from(keys.publicKey.export({ format: "jwk" }).x ?? "", "base64url");
const KEY_ID = sha256(PUBLIC).slice(0, 16);
// Every run on the same server gets its own id (the key is new each run).
const ID = `dev.e2etest.kpi${Date.now().toString(36)}`;
let dashboardId = "";

test.beforeAll(async ({ world }) => {
  const owner = await Api.owner();
  try {
    const trusted = await owner.context.post("/api/admin/plugin-keys", {
      data: { name: PUBLISHER, publicKey: PUBLIC.toString("base64") },
    });
    expect(trusted.status(), await trusted.text()).toBe(201);
    const installed = await owner.context.post("/api/admin/plugins", {
      headers: { "Content-Type": "application/zip" },
      data: panelPackage(ID, keys.privateKey),
    });
    expect(installed.status(), await installed.text()).toBe(201);
    for (const [path, data] of [
      [`/api/admin/plugins/${ID}/approve`, { version: "1.0.0" }],
      [`/api/admin/plugins/${ID}/enable`, undefined],
    ] as const) {
      const r = await owner.context.post(path, data === undefined ? {} : { data });
      expect(r.ok(), await r.text()).toBe(true);
    }
    dashboardId = await owner.createDashboard({
      schemaVersion: 1,
      title: "Plugin panel",
      timeRange: { from: "now-30d", to: "now" },
      variables: [],
      panels: [
        {
          id: "kpi",
          type: ID,
          title: "Revenue",
          grid: { x: 0, y: 0, w: 8, h: 8 },
          targets: [
            {
              refId: "A",
              datasourceId: world.sourceId,
              query: {
                sql: "SELECT region, ROUND(SUM(amount), 1) AS total FROM sales GROUP BY region ORDER BY region",
              },
            },
          ],
          options: { field: "total", decimals: 1 },
        },
      ],
    });
  } finally {
    await owner.dispose();
  }
});

test("a panel plugin draws in its sandboxed frame and is edited with options from its manifest", async ({
  page,
  consoleGuard,
}) => {
  // The example logs once that the field it was given is not a number field of the result.
  consoleGuard.allow(/no number field named missing/);
  await signInOwner(page);

  await test.step("the dashboard draws the panel in a sandboxed frame with its own policy", async () => {
    const frameResponse = page.waitForResponse((r) =>
      r.url().includes(`/panel-plugins/${ID}/frame`),
    );
    await page.goto(`/dashboards/${dashboardId}`);
    const response = await frameResponse;
    expect(response.status()).toBe(200);
    const csp = response.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    const iframe = page.locator(
      `iframe[title="${t("panelPlugins.frameTitle", { name: "Revenue" })}"]`,
    );
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    const frame = page.frameLocator(
      `iframe[title="${t("panelPlugins.frameTitle", { name: "Revenue" })}"]`,
    );
    // The tile shows the panel's title and the last value of the field, with one decimal.
    await expect(frame.locator(".label")).toHaveText("Revenue");
    await expect(frame.locator(".value")).toHaveText(/^\d[\d,.]*\.\d$/);
  });

  await test.step("the panel editor offers it with its publisher and builds its options", async () => {
    await page.goto(`/dashboards/${dashboardId}/panels/kpi/edit`);
    const options = page.getByRole("region", { name: t("dashboards.editor.preview") });
    await expect(options.frameLocator("iframe").locator(".value")).toBeVisible();
    // The visualization group is folded to the panel's name.
    await page.locator(".option-group__toggle", { hasText: NAME }).click();
    const card = page.locator(".picker__card").filter({ hasText: NAME });
    await expect(card).toContainText(t("panelPlugins.badgeBy", { publisher: PUBLISHER }));
    const field = page.getByLabel("Field", { exact: true });
    await expect(field).toHaveValue("total");
    await expect(page.getByLabel("Decimals", { exact: true })).toHaveAttribute("max", "10");
    await field.fill("missing");
    await expect(options.frameLocator("iframe").locator(".empty")).toHaveText("No number field");
  });
});
