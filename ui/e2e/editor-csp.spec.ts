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
  const response = await page.goto("/explore");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain("unsafe-inline");

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
