import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { checkoutTrace, searchFrame, TRACE_ID } from "../src/panels/trace/test/fixture";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// The screens of 0.7.5 against the real server: Verwaltung > CORS, Registrierung and Sicherungen
// with the server's own settings; traces with a Tempo source whose answers are given here (no
// Tempo runs beside the tests); an app and the visitor's registration with the routes a fresh
// server cannot serve on its own (an installed app, a mail server).
//
// With KALZIT_SHOTS set to a folder, each screen is also saved there in light and dark.

const SHOTS = process.env.KALZIT_SHOTS ?? "";

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === "") {
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Colours follow the scheme with a short transition.
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("searches traces without a query language and opens one as a waterfall", async ({ page }) => {
  const owner = await Api.owner();
  const name = unique("Tempo");
  const sourceId = await owner.createSource(name, "tempo", { url: "http://127.0.0.1:3200" });
  await owner.dispose();
  // The source's answers: a search is a table of traces, a trace id the trace.
  await page.route(/\/api\/orgs\/[^/]+\/query$/, async (route) => {
    const body = route.request().postDataJSON() as {
      queries: { refId: string; datasourceId: string; query: Record<string, unknown> }[];
    };
    const item = body.queries[0];
    if (item === undefined || item.datasourceId !== sourceId) {
      return route.continue();
    }
    const result =
      typeof item.query.traceId === "string"
        ? { shape: "trace", trace: checkoutTrace() }
        : { shape: "frame", frame: searchFrame() };
    return route.fulfill({ json: { results: { [item.refId]: { result } } } });
  });
  await page.route(new RegExp(`/api/orgs/[^/]+/datasources/${sourceId}/schema$`), (route) =>
    route.fulfill({
      json: {
        kind: "labels",
        labels: ["resource.service.name", "name", "span.http.status_code"],
        values: { "resource.service.name": ["frontend", "checkout"], name: ["GET /checkout"] },
      },
    }),
  );

  await signInOwner(page, "en");
  await page.goto(`/explore?source=${sourceId}`);
  await page.getByRole("combobox", { name: t("traces.query.service") }).fill("frontend");
  await page.getByRole("button", { name: t("traces.error"), exact: true }).click();
  await expect(
    page.getByText('{ resource.service.name = "frontend" && status = error }'),
  ).toBeVisible();
  await page.getByRole("button", { name: t("explore.run") }).click();
  const list = page.getByRole("table", { name: t("explore.result") });
  await expect(list.getByRole("row")).toHaveCount(3);
  await shot(page, "traces-search");

  await list.getByRole("button", { name: t("traces.open", { id: TRACE_ID.slice(0, 8) }) }).click();
  const grid = page.getByRole("treegrid", { name: t("explore.result") });
  await expect(grid.getByRole("row")).toHaveCount(13);
  // Errors are words, not only a colour.
  const failed = grid.locator('[data-span="00f067aa0ba902b7"]');
  await expect(failed.getByText(t("traces.error"))).toBeVisible();
  await failed.click();
  const detail = page.getByRole("complementary", { name: t("traces.span") });
  await expect(detail.getByText("upstream timeout after 3 retries")).toBeVisible();
  await shot(page, "traces-waterfall");
  await detail.getByRole("tab", { name: new RegExp(t("traces.tab.events")) }).click();
  await expect(detail.getByText("connect timeout")).toBeVisible();
  await shot(page, "traces-span-events");

  await page.getByRole("button", { name: t("traces.backToList") }).click();
  await expect(page.getByRole("table", { name: t("explore.result") })).toBeVisible();
});

test("sets CORS at once with undo and checks an origin", async ({ page }) => {
  await signInOwner(page, "en");
  await page.goto("/settings/cors");
  const field = page.getByRole("textbox", {
    name: t("admin.serverAdmin.cors.allowed_origins.label"),
  });
  await field.fill("*");
  await field.press("Enter");
  await expect(page.getByText(t("serverAdmin.cors.star"))).toBeVisible();
  const origin = `https://${unique("portal")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}.example.com`;
  await field.fill(origin);
  await field.press("Enter");
  const entries = page.getByRole("list", {
    name: t("admin.serverAdmin.cors.allowed_origins.label"),
  });
  await expect(entries.getByText(origin, { exact: true })).toBeVisible();

  const check = page.getByRole("form", { name: t("serverAdmin.cors.check") });
  await check.getByRole("textbox", { name: t("serverAdmin.cors.origin") }).fill(origin);
  await check.getByRole("button", { name: t("admin.updates.step.verify") }).click();
  // CORS itself is still off: the check says so instead of promising headers.
  await expect(check.getByRole("status")).toContainText(t("serverAdmin.cors.refused.off"));
  await shot(page, "settings-cors");

  await page.getByRole("button", { name: t("common.undo") }).click();
  await expect(entries.getByText(origin, { exact: true })).toHaveCount(0);
});

test("shows what self-registration needs and the backups without a target", async ({ page }) => {
  await signInOwner(page, "en");
  await page.goto("/settings/registration");
  const needs = page.getByRole("complementary", { name: t("serverAdmin.signup.needs") });
  await expect(needs.getByText(t("serverAdmin.signup.needMail"))).toBeVisible();
  await expect(
    page.getByRole("switch", { name: t("admin.settings.registration.enabled.label") }),
  ).toBeVisible();
  await shot(page, "settings-registration");

  await page.goto("/settings/backups");
  await expect(page.getByRole("heading", { name: t("serverAdmin.backup.noTarget") })).toBeVisible();
  await shot(page, "settings-backups");
  await page.getByRole("button", { name: t("serverAdmin.backup.setUp") }).click();
  const form = page.getByRole("form", { name: t("serverAdmin.backup.edit") });
  await form.getByText(t("serverAdmin.backup.s3"), { exact: true }).click();
  await expect(form.getByRole("textbox", { name: t("serverAdmin.backup.bucket") })).toBeVisible();
  // Save waits for a passed test.
  await expect(form.getByRole("button", { name: t("admin.common.save") })).toBeDisabled();
  await shot(page, "settings-backup-target");
});

test("creates an account as a visitor: address first, then the inbox", async ({ page }) => {
  await page.route(/\/api\/auth\/registration$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: { available: true, requiresApproval: true, allowedDomains: ["kalzit.test"] },
        })
      : route.fulfill({ status: 202, json: { accepted: true } }),
  );
  await page.goto("/login");
  await page.getByRole("link", { name: t("access.signup.title") }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: t("access.signup.title") }),
  ).toBeVisible();
  await shot(page, "register-start");
  await page.getByLabel(t("access.login.email")).fill("jonas.keller@kalzit.test");
  await page.getByRole("button", { name: t("access.signup.title") }).click();
  await expect(
    page.getByRole("heading", { name: t("serverAdmin.visitor.sentTitle") }),
  ).toBeVisible();
  await shot(page, "register-inbox");
});

test("opens an app's page from the sidebar in a sealed frame", async ({ page }) => {
  const app = {
    id: "dev.e2etest.capacity",
    name: "Capacity planning",
    version: "1.2.0",
    publisher: "Basalt Labs",
    api: 1,
    capabilities: ["dashboards:read", "storage"],
    pages: [
      { id: "overview", title: { en: "Overview", de: "Übersicht" } },
      { id: "forecast", title: { en: "Forecast", de: "Prognose" } },
    ],
  };
  await page.route(/\/api\/orgs\/[^/]+\/apps$/, (route) =>
    route.fulfill({ json: { items: [app] } }),
  );
  // The page as the server would frame it: it says it listens and asks for the dashboards.
  await page.route(/\/api\/orgs\/[^/]+\/apps\/[^/]+\/pages\/[^/]+\/frame$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;margin:16px">
<p id="out">…</p><script>
addEventListener("message", (e) => {
  if (e.source !== parent || !e.data || e.data.replyTo !== 1) return;
  out.textContent = e.data.error ? "refused" : "dashboards: " + e.data.result.items.length;
});
parent.postMessage({ kalzit: "app", api: 1, type: "ready" }, "*");
parent.postMessage({ kalzit: "app", api: 1, type: "dashboards.list", id: 1 }, "*");
</script>`,
    }),
  );
  await signInOwner(page, "en");
  await page
    .getByRole("navigation", { name: t("nav.label") })
    .getByRole("link", { name: "Capacity planning: Overview" })
    .click();
  await expect(page.getByText(t("apps.by", { publisher: "Basalt Labs" }))).toBeVisible();
  const frame = page.locator("iframe.app-frame");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  // The page got its answer through Kalzit, with the signed-in person's rights.
  await expect(frame.contentFrame().locator("#out")).toHaveText(/^dashboards: \d+$/);
  await page.getByRole("button", { name: t("apps.about") }).click();
  await expect(page.getByText(t("apps.cap.dashboards"))).toBeVisible();
  await shot(page, "app-page");
});
