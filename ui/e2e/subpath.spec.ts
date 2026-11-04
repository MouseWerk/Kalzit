import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, request, test } from "@playwright/test";
import { OUTPUT_DIR, serverEnv, stop, waitForAddress } from "./global-setup";
import { t } from "./support/i18n";

/**
 * Kalzit behind a reverse proxy under a sub-path (`server.base_path`, docs/guide/reverse-proxy.md):
 * a server of its own with `/kalzit`, as a proxy that keeps the prefix would pass requests on.
 * Every page, file, API call and live connection stays below the prefix.
 */
const BASE = "/kalzit";
const OWNER = { email: "subpath@example.com", password: "subpath-owner-password-e2e" };

let child: ChildProcess | undefined;
let origin = "";

test.beforeAll(async () => {
  const exe = process.env.KALZIT_E2E_EXE;
  const run = process.env.KALZIT_E2E_RUN;
  if (exe === undefined || run === undefined) {
    throw new Error("global setup did not name the binary and run folder");
  }
  const dir = join(run, "subpath");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(12).toString("hex");
  const log = createWriteStream(join(OUTPUT_DIR, "server-subpath.log"));
  child = spawn(exe, ["serve"], {
    cwd: dir,
    env: serverEnv({
      KALZIT_SERVER_HTTP_ADDR: "127.0.0.1:0",
      KALZIT_SERVER_BASE_PATH: BASE,
      KALZIT_PATHS_DATA_DIR: join(dir, "data"),
      KALZIT_SETUP_TOKEN: token,
      KALZIT_SECRETS_KEY: randomBytes(32).toString("base64"),
      KALZIT_SETTING_APPEARANCE_DEFAULT_LANGUAGE: "en",
      KALZIT_LOG_LEVEL: "info",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await waitForAddress(child, (text) => log.write(text));
  const api = await request.newContext({ baseURL: origin });
  try {
    const setup = await api.post(`${BASE}/api/setup`, {
      data: { token, orgName: "Sub-path", name: "Owner", ...OWNER },
    });
    expect(setup.ok(), await setup.text()).toBe(true);
  } finally {
    await api.dispose();
  }
});

test.afterAll(async () => {
  if (child !== undefined) {
    await stop(child);
  }
});

test("the app works below its sub-path and asks for nothing outside it", async ({ page }) => {
  // The root points to the sub-path.
  await page.goto(`${origin}/`);
  await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/`));

  const outside: string[] = [];
  const inside = (url: string) => {
    const { origin: o, pathname } = new URL(url);
    return o.replace(/^ws/, "http") !== origin || pathname.startsWith(`${BASE}/`);
  };
  page.on("request", (r) => {
    if (!inside(r.url())) outside.push(r.url());
  });
  page.on("websocket", (ws) => {
    if (!inside(ws.url())) outside.push(ws.url());
  });

  await page.goto(`${origin}${BASE}/login`);
  await page.getByLabel(t("access.login.email", {}, "en")).fill(OWNER.email);
  await page.getByLabel(t("access.login.password", {}, "en"), { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: t("access.login.submit", {}, "en") }).click();
  const nav = page.getByRole("navigation", { name: t("nav.label", {}, "en") });
  await expect(nav).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/`));

  // A link of the app keeps the prefix, and a deep link loads the app shell with its files.
  await nav.getByRole("link", { name: t("explore.nav", {}, "en") }).click();
  await expect(page).toHaveURL(new RegExp(`^${origin}${BASE}/explore`));
  await page.reload();
  await expect(nav).toBeVisible();

  expect(outside).toEqual([]);
});
