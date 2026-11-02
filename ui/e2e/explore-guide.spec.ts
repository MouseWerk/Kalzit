import { join } from "node:path";
import { Api, fixturesDir, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

test("someone new to SQL starts in Explore from a starter and sees the rows", async ({ page }) => {
  const owner = await Api.owner();
  const id = await owner.createSqliteSource(unique("Verkäufe"), join(fixturesDir(), "sales.db"));
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/explore?source=${id}`);

  // The start panel names what the source holds and offers the fixture's tables.
  const start = page.getByRole("region", { name: t("explore.guide.title", { kind: "SQLite" }) });
  await expect(start).toContainText(t("help.source.sql.holds"));
  await start.getByLabel(t("help.pick.table")).selectOption("sales");

  // The query behind the starter can be seen before it is used.
  await start.getByText(t("help.showQuery")).first().click();
  await expect(start.locator("pre").first()).toContainText("FROM sales");

  await start.getByRole("button", { name: t("help.starter.sql.rows") }).click();
  const result = page.getByRole("region", { name: t("explore.result") });
  await expect(result.getByLabel(t("explore.visualization"))).toBeVisible();
  // The query stays in the editor, to learn from and to change.
  await expect(
    page.getByRole("region", { name: t("explore.guide.title", { kind: "SQLite" }) }),
  ).toHaveCount(0);
  await result.getByRole("tab", { name: t("explore.tab.inspect") }).click();
  await expect(result).toContainText(/100 rows/);

  // The cheat sheet opens from the keyboard, also while the editor has the focus (Shift+F1;
  // there Ctrl+/ stays the editor's comment toggle).
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Shift+F1");
  const sheet = page.getByRole("region", {
    name: t("explore.guide.cheatTitle", { language: "SQL" }),
  });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("searchbox", { name: t("help.panel.search") }).fill("GROUP BY");
  await expect(
    sheet.getByRole("heading", { name: t("help.cheat.sql.groupBy.title") }),
  ).toBeVisible();
});
