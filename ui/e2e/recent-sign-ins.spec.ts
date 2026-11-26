import { request } from "@playwright/test";
import { Api, baseUrl, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

test("Sign-in and security lists the person's own recent sign-ins with browser and address", async ({
  pageAs,
}) => {
  const owner = await Api.owner();
  let member: { id: string; email: string; password: string };
  try {
    member = await owner.createMember(unique("Rita Recent"), "viewer");
  } finally {
    await owner.dispose();
  }
  // One refused attempt before the real sign-in: it is listed with its reason.
  const wrong = await request.newContext({ baseURL: baseUrl() });
  try {
    const refused = await wrong.post("/api/auth/login", {
      data: { email: member.email, password: `${member.password}-wrong` },
    });
    expect(refused.status()).toBe(401);
  } finally {
    await wrong.dispose();
  }

  const page = await pageAs(member.email, member.password);
  await page.goto("/settings/account-security", { timeout: STEP_MS });
  const aside = page.getByRole("complementary", { name: t("security.signIns.title") });
  const items = aside.getByRole("listitem");

  await test.step("this session comes first, with time, method, browser and address", async () => {
    await expect(items.first()).toContainText(t("security.signIns.thisSession"), {
      timeout: STEP_MS,
    });
    await expect(items.first()).toContainText(
      t("security.signIns.today", { time: "" }).trim().replace(/,$/, ""),
    );
    await expect(items.first()).toContainText(t("security.signIns.method.password"));
    await expect(items.first()).toContainText("Chrome");
    // The address the server saw; the e2e server runs on this machine.
    await expect(items.first()).toContainText(/127\.0\.0\.1|::1/);
  });

  await test.step("the refused attempt is listed with its reason, and only own sign-ins", async () => {
    await expect(items).toHaveCount(2);
    await expect(items.nth(1)).toContainText(t("security.signIns.refused"));
    await expect(items.nth(1)).toContainText(t("security.signIns.reason.credentials"));
  });

  await test.step("the list links to the sessions", async () => {
    await aside.getByRole("link", { name: t("security.signIns.allSessions") }).click();
    await expect(page).toHaveURL(/\/settings\/profile#sessions$/, { timeout: STEP_MS });
  });

  await test.step("the list is bounded, and another person's sign-ins stay closed", async () => {
    const answer = await page.request.get(`/api/admin/users/${member.id}/sign-ins`);
    expect(answer.status()).toBe(403);
    const own = await page.request.get("/api/me/sign-ins?limit=500");
    expect(own.status()).toBe(422);
  });
});
