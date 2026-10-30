import { createHmac } from "node:crypto";
import { request } from "@playwright/test";
import { Api, baseUrl, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

/** Base32 (RFC 4648) without padding, as the server shows the key. */
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

/** The TOTP code (RFC 6238: HMAC-SHA-1, 30 s, 6 digits) of `step`. */
function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = (hash.at(-1) ?? 0) & 0x0f;
  const binary = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

const step = () => Math.floor(Date.now() / 30_000);

test("signs in with the code of an authenticator app after the password", async ({ page }) => {
  const owner = await Api.owner();
  const person = await owner.createMember(unique("Totp"), "viewer");
  await owner.dispose();

  // The person sets up the app through the API, as the account page would.
  const own = await request.newContext({ baseURL: baseUrl() });
  const login = await own.post("/api/auth/login", {
    data: { email: person.email, password: person.password },
  });
  expect(login.ok()).toBe(true);
  const setup = await (await own.post("/api/me/security/totp/setup", { data: {} })).json();
  const secret = base32Decode(String(setup.secret));
  const first = step();
  const saved = await own.post("/api/me/security/totp", { data: { code: totp(secret, first) } });
  expect(saved.ok()).toBe(true);
  await own.dispose();

  await page.goto("/login");
  await page.getByLabel(t("access.login.email")).fill(person.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(person.password);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByRole("heading", { name: t("security.signIn.title") })).toBeVisible();

  // Nothing of the app is reachable before the second factor.
  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(401);

  // The step after the one that confirmed the key: each step works once, one ahead is accepted.
  await page.getByLabel(t("security.factor.code")).fill(totp(secret, first + 1));
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(200);
});
