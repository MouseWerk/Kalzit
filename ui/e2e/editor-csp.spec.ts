import { join } from "node:path";
import { Api, fixturesDir, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

/**
 * CodeMirror writes its styles into a `<style>` element, which the server's CSP
 * (`style-src 'self'`) refuses; the UI mirrors them into a constructed style sheet
 * (editorStyles.ts). This runs in every engine, under the real header, and checks that the
 * editor has its frame, layout and theme.
 */
test("the query editor is styled under the server's Content-Security-Policy", async ({ page }) => {
  const owner = await Api.owner();
  const name = unique("CSP");
  await owner.createSqliteSource(name, join(fixturesDir(), "sales.db"));
  await owner.dispose();

  await signInOwner(page);
  // The policy of the document the editor runs in (loaded at the sign-in) and of Explore's own
  // address, which the server sends the same way.
  for (const path of ["/login", "/explore"]) {
    const csp = (await page.request.get(path)).headers()["content-security-policy"] ?? "";
    expect(csp, path).toContain("style-src 'self'");
    expect(csp, path).not.toContain("unsafe-inline");
  }
  // Within the app: a full page load here would cancel the start page's requests still under
  // way, which WebKit reports as console errors ("... due to access control checks").
  await page
    .getByRole("navigation", { name: t("nav.label") })
    .getByRole("link", { name: t("explore.nav"), exact: true })
    .click();
  await expect(page).toHaveURL(/\/explore(\?|$)/);

  await page.getByLabel(t("explore.datasource")).selectOption({ label: name });
  const editor = page.locator(".cm-editor");
  await expect(editor).toBeVisible();

  const styles = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => root.getPropertyValue(name).trim();
    const probe = document.createElement("div");
    document.body.append(probe);
    const px = (value: string) => {
      probe.style.width = value;
      return getComputedStyle(probe).width;
    };
    const cm = document.querySelector(".cm-editor");
    const scroller = document.querySelector(".cm-scroller");
    const content = document.querySelector(".cm-content");
    if (cm === null || scroller === null || content === null) {
      throw new Error("the editor is incomplete");
    }
    const editorStyle = getComputedStyle(cm);
    const scrollerStyle = getComputedStyle(scroller);
    const result = {
      // CodeMirror's base theme.
      display: editorStyle.display,
      flexDirection: editorStyle.flexDirection,
      overflowX: scrollerStyle.overflowX,
      whiteSpace: getComputedStyle(content).whiteSpace,
      // Kalzit's theme, from the design tokens.
      borderWidth: editorStyle.borderTopWidth,
      expectedBorderWidth: px(token("--border-width")),
      radius: editorStyle.borderTopLeftRadius,
      expectedRadius: px(token("--radius-md")),
      font: scrollerStyle.fontFamily,
      expectedFont: token("--font-mono"),
      minHeight: scrollerStyle.minHeight,
      expectedMinHeight: px(token("--size-editor-min")),
    };
    probe.remove();
    return result;
  });

  expect(styles.display).toBe("flex");
  expect(styles.flexDirection).toBe("column");
  expect(styles.overflowX).toBe("auto");
  // "pre", or "break-spaces" with line wrapping; without the styles it would be "normal".
  expect(["pre", "break-spaces"]).toContain(styles.whiteSpace);
  expect(styles.borderWidth).toBe(styles.expectedBorderWidth);
  expect(styles.borderWidth).not.toBe("0px");
  expect(styles.radius).toBe(styles.expectedRadius);
  // Engines differ in how they quote family names.
  const family = (value: string) => value.replace(/[\s"']/g, "");
  expect(family(styles.font)).toBe(family(styles.expectedFont));
  expect(styles.minHeight).toBe(styles.expectedMinHeight);

  // And it works: a query typed into it runs.
  await fillQuery(page, SQL.series);
  await page.getByRole("button", { name: t("explore.run") }).click();
  await expect(
    page.getByRole("region", { name: t("explore.result") }).locator(".ts__plot"),
  ).toBeVisible();
});

/**
 * Probes that the console guard's allowance for CodeMirror's refused style stays narrow: any
 * other inline style the policy refuses fails the test, in every engine. Expected to fail.
 */
const REFUSED_STYLES = {
  "a <style> element": () => {
    const style = document.createElement("style");
    style.textContent = "body { color: red; }";
    document.head.append(style);
  },
  "a style attribute": () => {
    document.querySelector("main")?.setAttribute("style", "color: red");
  },
} as const;

for (const [name, inject] of Object.entries(REFUSED_STYLES)) {
  test(`the console guard catches ${name} on an admin page`, async ({ page }) => {
    test.fail(true, "the probe adds an inline style the policy refuses, on purpose");
    await signInOwner(page);
    await page.goto("/admin/members");
    await expect(page.getByRole("heading", { name: t("admin.members.title") })).toBeVisible();
    await page.evaluate(inject);
    // Gives the browser time to report the refusal before the guard checks.
    await page.waitForTimeout(500);
  });
}
