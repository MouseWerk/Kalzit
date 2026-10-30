import { createHmac } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  request,
  test,
} from "@playwright/test";
import { baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { DEMO_OWNER, SCREENSHOT_NOW } from "./demo";

/**
 * The second factor's screens (docs/design/blueprint/Identity.dc.html, frames 2A, 2C, 2D, 4A and
 * 5G). Runs after readme.shots.ts (files run in name order), which completed setup and seeded the
 * demo organization; it adds two people of its own and leaves the server's rule off again.
 */
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "screenshots",
);

test.describe.configure({ mode: "serial" });

function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/\s/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = (hash.at(-1) ?? 0) & 0x0f;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function api(email: string, password: string): Promise<APIRequestContext> {
  const context = await request.newContext({ baseURL: baseUrl() });
  const login = await context.post("/api/auth/login", { data: { email, password } });
  expect(login.ok(), await login.text()).toBe(true);
  return context;
}

async function person(owner: APIRequestContext, name: string, email: string, password: string) {
  const me = await (await owner.get("/api/me")).json();
  await owner.post("/api/admin/users", { data: { name, email, password } });
  await owner.post(`/api/orgs/${me.orgs[0].id}/members`, { data: { email, role: "editor" } });
}

async function openPage(
  browser: Browser,
  colorScheme: "light" | "dark",
  width = 1440,
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
}

async function password(page: Page, email: string, secret: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("access.login.email")).fill(email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(secret);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
}

const LEA = {
  name: "Lea Hoffmann",
  email: "lea.hoffmann@kalzit.test",
  password: "demo-password-lea",
};
const TOM = {
  name: "Tobias Brandt",
  email: "tobias.brandt@kalzit.test",
  password: "demo-password-tobias",
};

test("second factor: sign-in, account and policy", async ({ browser }) => {
  const owner = await api(DEMO_OWNER.email, DEMO_OWNER.password);
  await person(owner, LEA.name, LEA.email, LEA.password);
  await person(owner, TOM.name, TOM.email, TOM.password);

  // Lea sets up the app through the API, as the account page would.
  const lea = await api(LEA.email, LEA.password);
  const setup = await (await lea.post("/api/me/security/totp/setup", { data: {} })).json();
  const secret = base32Decode(String(setup.secret));
  const first = Math.floor(Date.now() / 30_000);
  expect(
    (await lea.post("/api/me/security/totp", { data: { code: totp(secret, first) } })).ok(),
  ).toBe(true);
  await lea.dispose();

  // Frame 2A: the second step, dark.
  let page = await openPage(browser, "dark");
  await password(page, LEA.email, LEA.password);
  await expect(page.getByRole("heading", { name: t("security.signIn.title") })).toBeVisible();
  await shoot(page, "two-factor-sign-in-dark");
  // Then signed in, the account page (frame 4A).
  await page.getByLabel(t("security.factor.code")).fill(totp(secret, first + 1));
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  await page.goto("/settings/account-security");
  await expect(
    page.getByRole("heading", { name: t("security.account.secondFactor") }),
  ).toBeVisible();
  await shoot(page, "two-factor-account-dark");
  await page.context().close();

  // Frame 2D: the second step at 360 px, light.
  page = await openPage(browser, "light", 360);
  await password(page, LEA.email, LEA.password);
  await expect(page.getByRole("heading", { name: t("security.signIn.title") })).toBeVisible();
  await shoot(page, "two-factor-sign-in-phone");
  await page.context().close();

  // Frame 5G: the policy on the server, as its admin sees it.
  page = await openPage(browser, "light");
  await password(page, DEMO_OWNER.email, DEMO_OWNER.password);
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  await page.goto("/settings/signin");
  await expect(page.getByRole("heading", { name: t("security.policy.perOrg") })).toBeVisible();
  await shoot(page, "two-factor-policy");
  await page.context().close();

  // Frame 2C: with a rule for everyone, Tobias sets one up at his next sign-in.
  const rule = await owner.patch("/api/admin/settings/security.two_factor_required", {
    data: { value: "everyone", version: 0 },
  });
  expect(rule.ok(), await rule.text()).toBe(true);
  try {
    page = await openPage(browser, "light");
    await password(page, TOM.email, TOM.password);
    await expect(page.getByRole("heading", { name: t("security.setup.title") })).toBeVisible();
    await shoot(page, "two-factor-setup");
    await page.getByRole("radio", { name: new RegExp(t("security.setup.app")) }).click();
    await page.getByRole("button", { name: t("security.setup.next") }).click();
    await expect(page.getByRole("heading", { name: t("security.setup.appTitle") })).toBeVisible();
    await shoot(page, "two-factor-setup-app");
    await page.context().close();
  } finally {
    const stored = await (await owner.get("/api/admin/settings")).json();
    const current = (stored as { items: { key: string; version: number }[] }).items.find(
      (s) => s.key === "security.two_factor_required",
    );
    await owner.patch("/api/admin/settings/security.two_factor_required", {
      data: { value: "off", version: current?.version ?? 1 },
    });
    await owner.dispose();
  }
});
