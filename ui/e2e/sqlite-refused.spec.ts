import { join } from "node:path";
import { fixturesDir, OWNER_DE, unique } from "./support/api";
import { de } from "./support/i18n";
import { expect, test } from "./support/test";

const CASES = [
  ["Kalzit's own database", () => join(process.env.KALZIT_E2E_DATA_DIR ?? "", "kalzit.db")],
  ["a file outside the allowed folders", () => join(fixturesDir(), "..", "elsewhere.db")],
] as const;

for (const [what, path] of CASES) {
  test(`a refused SQLite path (${what}) shows the German reason`, async ({
    pageAs,
    consoleGuard,
  }) => {
    // The server refuses the new source with 422, which the browser logs.
    consoleGuard.allow(/status of 422 .*\/datasources$/);
    const page = await pageAs(OWNER_DE.email, OWNER_DE.password, { locale: "de-DE" });
    await page.goto("/data-sources/new?kind=sqlite");
    await page.getByLabel(de("datasources.form.name")).fill(unique("Abgelehnt"));
    const file = page.getByLabel(de("datasources.settings.path"));
    await file.fill(path());
    await page.getByRole("button", { name: de("datasources.form.create") }).click();

    await expect(page.getByText(de("datasources.reason.target.sqlite_path_refused"))).toBeVisible();
    await expect(file).toHaveAttribute("aria-invalid", "true");
    // Still on the form: nothing was created.
    await expect(page).toHaveURL(/\/data-sources\/new/);
  });
}
