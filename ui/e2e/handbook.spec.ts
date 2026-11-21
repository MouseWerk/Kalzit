import { seriousViolations } from "./support/axe";
import { de, t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

// The built-in handbook against the real server and the real bundle (board Handbook.dc.html):
// pages, pictures and the search index are files of the binary, fetched when shown; the search
// runs in the browser and sends nothing to the server.

test("opens from the Help menu and shows a page with its picture, contents and sections", async ({
  page,
}) => {
  await signInOwner(page, "en");
  await page.goto("/");
  await page.getByRole("button", { name: t("shell.top.help") }).click();
  await page.getByRole("menuitem", { name: t("shell.top.handbook") }).click();
  await expect(page).toHaveURL(/\/handbook\/overview$/);
  await expect(page.getByRole("heading", { level: 1, name: "Kalzit user guide" })).toBeVisible();

  await page
    .getByRole("navigation", { name: t("handbook.contents") })
    .getByRole("link", { name: "Explore", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
  await expect(page).toHaveTitle("Explore · Handbook · Kalzit");
  // The screenshot is part of the binary and loads.
  const picture = page.getByRole("img", { name: "Explore with a SQL query and a time series" });
  await expect(picture).toBeVisible();
  expect(await picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test("searches in the browser and opens the section of a hit", async ({ page }) => {
  await signInOwner(page, "en");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/handbook/overview");
  await page.keyboard.press("/");
  const field = page.getByRole("combobox", { name: t("handbook.search.label") });
  await expect(field).toBeFocused();
  await field.fill("restore drill");
  const results = page.getByRole("listbox", { name: t("handbook.search.results") });
  await expect(results.getByRole("option", { name: /Restore drill/ }).first()).toBeVisible();
  expect(requests.filter((url) => /restore/i.test(url))).toEqual([]);
  await field.press("Enter");
  await expect(page).toHaveURL(/\/handbook\/backup#restore-drill$/);
});

test("follows the language of the interface", async ({ page }) => {
  await signInOwner(page, "de");
  await page.goto("/handbook/explore");
  await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: de("handbook.onThisPage") }).getByRole("link", {
      name: "Bei null anfangen",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: de("handbook.readIn.en") })).toBeVisible();
});
