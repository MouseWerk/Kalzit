import { join } from "node:path";
import { Api, fixturesDir, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
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

  await selectOption(page.getByLabel(t("explore.datasource")), { label: name });
  const editor = page.locator(".cm-editor");
  await expect(editor).toBeVisible();

  // Explore and its editor are lazy chunks: they fetch their scripts through the import, not
  // through modulepreload links added on the way, which WebKit reports as unused when its
  // timer after the load event runs before the import asked for them (vite.config.ts).
  const html = await (await page.request.get("/explore")).text();
  // The shell itself keeps its preloads, so the first load still fetches in parallel.
  expect(html).toContain('rel="modulepreload"');
  const addedPreloads = await page.evaluate(
    (served) =>
      [...document.querySelectorAll('link[rel="modulepreload"]')]
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => !served.includes(`"${href}"`)),
    html,
  );
  expect(addedPreloads).toEqual([]);

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

/**
 * A notice is checked a moment after it was reported; a page that goes on to another document
 * right after a style write (the panel editor, then a `page.goto`) is still checked against the
 * document that wrote it: CodeMirror's styles pass, any other inline style fails.
 */
const STYLE_THEN_LEAVE = {
  "CodeMirror's styles pass": { css: ".cm-probe { color: red; }", problem: null },
  "any other style fails": {
    css: "body { color: red; }",
    problem: "[inline style that is not CodeMirror's: body { color: red; }]",
  },
} as const;

for (const [name, { css, problem }] of Object.entries(STYLE_THEN_LEAVE)) {
  test(`the console guard checks a style written right before a navigation: ${name}`, async ({
    page,
    consoleGuard,
  }) => {
    const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'";
    const html = (script: string) => ({
      contentType: "text/html",
      headers: { "content-security-policy": csp },
      body: `<!doctype html><main></main><script>${script}</script>`,
    });
    await page.route("**/guard-probe/one", (route) =>
      route.fulfill(
        html(`addEventListener("load", () => setTimeout(() => {
          const style = document.createElement("style");
          style.textContent = ${JSON.stringify(css)};
          document.head.append(style);
          location.href = "two";
        }, 300));`),
      ),
    );
    await page.route("**/guard-probe/two", (route) => route.fulfill(html("")));
    await page.goto("/guard-probe/one");
    await expect(page).toHaveURL(/\/guard-probe\/two$/);
    // Gives the browser time to report the refusal before the guard checks.
    await page.waitForTimeout(500);
    const found = await consoleGuard.drain();
    if (problem === null) {
      expect(found).toEqual([]);
    } else {
      // Every notice of the refused style names it, however many the browser reports.
      expect(found.length).toBeGreaterThan(0);
      for (const line of found) {
        expect(line).toContain(problem);
      }
    }
  });
}
