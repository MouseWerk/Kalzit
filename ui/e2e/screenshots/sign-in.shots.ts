import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, request, test } from "@playwright/test";
import { baseUrl } from "../support/api";
import { t } from "../support/i18n";
import { DEMO_OWNER, SCREENSHOT_NOW } from "./demo";

/**
 * The sign-in and identity screens of M5 (docs/design/blueprint/Identity.dc.html): the providers
 * with OpenID Connect, LDAP and SAML, the LDAP and SAML dialogs, service accounts with the SCIM
 * card, and the recent sign-ins on the account page and for a server admin. Runs after
 * readme.shots.ts (files run in name order), which completed setup and seeded the demo
 * organization.
 *
 * The e2e services have no identity provider or directory, so the providers and their dialogs are
 * answered from the fixtures below, as the gallery does with the plugin catalog. The recent
 * sign-ins are answered the same way: the run signs in only with a password, and the list shows
 * the mix of methods a real installation has.
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

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const OIDC = {
  id: "shot-oidc",
  slug: "mueller-sso",
  kind: "oidc",
  name: "Müller SSO",
  issuer: "https://sso.mueller.example/realms/kalzit",
  position: 0,
  enabled: true,
  people: 186,
  lastSignInAt: SCREENSHOT_NOW - 4 * MINUTE,
  checkedAt: SCREENSHOT_NOW - 3 * DAY,
  createAccounts: true,
  trustProviderMfa: false,
  redirectUri: "https://kalzit.mueller.example/auth/oidc/mueller-sso/callback",
};

const LDAP_SETTINGS = {
  flavor: "ad",
  url: "ldaps://dc01.mueller.example:636",
  encryption: "ldaps",
  certificate: "system",
  caPem: null,
  bindDn: "CN=svc-kalzit,OU=Dienste,DC=mueller,DC=example",
  bindPasswordSet: true,
  userBaseDn: "OU=Mitarbeitende,DC=mueller,DC=example",
  loginAttribute: "sAMAccountName",
  userFilter: "",
  groupBaseDn: "OU=Gruppen,DC=mueller,DC=example",
  nestedGroups: true,
  emailAttribute: "mail",
  nameAttribute: "displayName",
  trustEmail: true,
  syncSchedule: "daily",
  syncHour: 2,
  syncThreshold: 10,
};

const LDAP = {
  id: "shot-ldap",
  slug: "zentrale",
  kind: "ldap",
  name: "Verzeichnis Zentrale",
  issuer: "ldaps://dc01.mueller.example:636",
  flavor: "ad",
  position: 1,
  enabled: true,
  people: 342,
  lastSignInAt: SCREENSHOT_NOW - 22 * MINUTE,
  checkedAt: SCREENSHOT_NOW - 3 * DAY,
  createAccounts: true,
  trustProviderMfa: false,
  redirectUri: "",
};

const SAML_SETTINGS = {
  metadataUrl: "https://idp.partnerportal.example/saml/metadata.xml",
  idpEntityId: "https://idp.partnerportal.example/saml",
  ssoUrl: "https://idp.partnerportal.example/saml/sso",
  certificates: ["MIIC8DCCAdigAwIBAgIQShotFixture"],
  certificateInfo: [
    {
      fingerprint: "3F:A1:7C:22:9B:0E:51:D4:88:6A:F2:13:C9:40:7E:B5:2D:66:91:0C",
      subject: "CN=idp.partnerportal.example",
      notAfter: SCREENSHOT_NOW + 240 * DAY,
      expired: false,
    },
  ],
  emailAttribute: "mail",
  nameAttribute: "displayName",
  groupsAttribute: "memberOf",
  trustEmail: false,
};

const SAML = {
  id: "shot-saml",
  slug: "partnerportal",
  kind: "saml",
  name: "Partnerportal",
  issuer: "https://idp.partnerportal.example/saml",
  position: 2,
  enabled: true,
  people: 27,
  lastSignInAt: SCREENSHOT_NOW - 2 * DAY,
  checkedAt: SCREENSHOT_NOW - 9 * DAY,
  createAccounts: true,
  trustProviderMfa: false,
  redirectUri: "https://kalzit.mueller.example/auth/saml/partnerportal/acs",
};

const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0";
const SAFARI_PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

/** Sign-ins as frame 4A shows them, around the screenshot moment. */
function signIns(current: boolean) {
  const base = {
    reason: null,
    provider: null,
    providerName: null,
    secondFactor: null,
    userAgent: FIREFOX_WINDOWS,
    current: false,
  };
  return [
    {
      ...base,
      id: "si-5",
      at: SCREENSHOT_NOW - 18 * MINUTE,
      result: "success",
      method: "oidc",
      provider: "mueller-sso",
      providerName: "Müller SSO",
      secondFactor: "passkey",
      address: "10.20.4.17",
      current,
    },
    {
      ...base,
      id: "si-4",
      at: SCREENSHOT_NOW - DAY + 5 * 60 * MINUTE,
      result: "success",
      method: "oidc",
      provider: "mueller-sso",
      providerName: "Müller SSO",
      secondFactor: "passkey",
      address: "10.20.9.112",
      userAgent: SAFARI_PHONE,
    },
    {
      ...base,
      id: "si-3",
      at: SCREENSHOT_NOW - DAY + 4 * 60 * MINUTE,
      result: "refused",
      reason: "credentials",
      method: "password",
      address: "10.20.9.112",
      userAgent: SAFARI_PHONE,
    },
    {
      ...base,
      id: "si-2",
      at: SCREENSHOT_NOW - 6 * DAY - 6 * 60 * MINUTE,
      result: "success",
      method: "ldap",
      provider: "zentrale",
      providerName: "Verzeichnis Zentrale",
      secondFactor: "totp",
      address: "10.20.4.17",
      userAgent: EDGE_WINDOWS,
    },
    {
      ...base,
      id: "si-1",
      at: SCREENSHOT_NOW - 47 * DAY,
      result: "success",
      method: "break_glass",
      secondFactor: "passkey",
      address: "10.20.0.2",
    },
  ];
}

async function openPage(browser: Browser, colorScheme: "light" | "dark" = "light"): Promise<Page> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "Europe/Berlin",
    colorScheme,
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(SCREENSHOT_NOW);
  return page;
}

/** Answers the providers and their dialogs from the fixtures; everything else is the server's. */
async function stubProviders(page: Page): Promise<void> {
  await page.context().route(/\/api\/admin\/sign-in(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        providers: [OIDC, LDAP, SAML],
        accounts: 612,
        viaProviders: 555,
        redirectBase: "https://kalzit.mueller.example",
        samlBase: "https://kalzit.mueller.example",
      },
    });
  });
  await page
    .context()
    .route(/\/api\/admin\/sign-in\/providers\/shot-[a-z]+(\?|$)/, async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      const common = { version: 3 };
      if (id === LDAP.id) {
        await route.fulfill({ json: { ...LDAP, ...common, ldap: LDAP_SETTINGS } });
      } else if (id === SAML.id) {
        await route.fulfill({
          json: {
            ...SAML,
            ...common,
            spEntityId: "https://kalzit.mueller.example/auth/saml/partnerportal/metadata",
            acsUrl: SAML.redirectUri,
            spMetadataUrl: "https://kalzit.mueller.example/auth/saml/partnerportal/metadata",
            saml: SAML_SETTINGS,
          },
        });
      } else {
        await route.continue();
      }
    });
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(t("access.login.email")).fill(DEMO_OWNER.email);
  await page.getByLabel(t("access.login.password"), { exact: true }).fill(DEMO_OWNER.password);
  await page.getByRole("button", { name: t("access.login.submit") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
}

/** Whether a field of the open dialog holds `value` (the stored provider has loaded). */
function hasValue(page: Page, value: string): Promise<boolean> {
  return page
    .getByRole("dialog")
    .locator("input, textarea")
    .evaluateAll(
      (fields, wanted) => fields.some((f) => (f as HTMLInputElement).value === wanted),
      value,
    );
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

test("sign-in providers and their dialogs", async ({ browser }) => {
  const page = await openPage(browser);
  await stubProviders(page);
  await signIn(page);
  await page.goto("/settings/signin");
  const table = page.getByRole("table").first();
  for (const provider of [OIDC, LDAP, SAML]) {
    await expect(table.getByText(provider.name, { exact: true })).toBeVisible();
  }
  await shoot(page, "sign-in-providers");

  await page
    .getByRole("button", { name: t("sso.providers.editNamed", { name: LDAP.name }) })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => hasValue(page, LDAP_SETTINGS.url)).toBe(true);
  await shoot(page, "sign-in-ldap");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page
    .getByRole("button", { name: t("sso.providers.editNamed", { name: SAML.name }) })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect.poll(() => hasValue(page, SAML_SETTINGS.idpEntityId)).toBe(true);
  await shoot(page, "sign-in-saml");
  await page.context().close();
});

test("service accounts and the SCIM card", async ({ browser }) => {
  // A service account with a token, and the organization's SCIM token, made as an admin would.
  const owner = await request.newContext({ baseURL: baseUrl() });
  const login = await owner.post("/api/auth/login", {
    data: { email: DEMO_OWNER.email, password: DEMO_OWNER.password },
  });
  expect(login.ok(), await login.text()).toBe(true);
  const org = (await login.json()).orgs[0].id as string;
  const account = await owner.post(`/api/orgs/${org}/service-accounts`, {
    data: { name: "etl-nightly", description: "Nightly import from the ERP", role: "editor" },
  });
  expect(account.ok(), await account.text()).toBe(true);
  const accountId = (await account.json()).id as string;
  const token = await owner.post(`/api/orgs/${org}/service-accounts/${accountId}/tokens`, {
    data: { name: "import job", expiresInDays: 90, allowedIps: ["10.20.0.0/16"] },
  });
  expect(token.ok(), await token.text()).toBe(true);
  const scim = await owner.post(`/api/orgs/${org}/scim-token`, { data: { expiresInDays: 180 } });
  expect(scim.ok(), await scim.text()).toBe(true);
  const on = await owner.put(`/api/orgs/${org}/scim`, { data: { enabled: true } });
  expect(on.ok(), await on.text()).toBe(true);
  await owner.dispose();

  const page = await openPage(browser);
  await signIn(page);
  await page.goto("/admin/service-accounts");
  await expect(page.getByText("etl-nightly", { exact: true }).first()).toBeVisible();
  await shoot(page, "service-accounts");
  const card = page.getByRole("region", { name: t("admin.serviceAccounts.scimTitle") });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await shoot(page, "scim");
  await page.context().close();
});

test("recent sign-ins", async ({ browser }) => {
  for (const colorScheme of ["dark", "light"] as const) {
    const page = await openPage(browser, colorScheme);
    await page
      .context()
      .route(/\/api\/me\/sign-ins(\?|$)/, (route) =>
        route.fulfill({ json: { items: signIns(true), nextCursor: null } }),
      );
    await signIn(page);
    await page.goto("/settings/account-security");
    const list = page.getByRole("list", { name: t("security.signIns.title") });
    await expect(list.getByRole("listitem")).toHaveCount(5);
    await shoot(page, `recent-sign-ins-${colorScheme}`);
    await page.context().close();
  }

  // A server admin opens them from the user list.
  const page = await openPage(browser);
  await page
    .context()
    .route(/\/api\/admin\/users\/[^/]+\/sign-ins(\?|$)/, (route) =>
      route.fulfill({ json: { items: signIns(false), nextCursor: null } }),
    );
  await signIn(page);
  await page.goto("/admin/server/users");
  await page
    .getByRole("button", { name: t("security.signIns.adminShowNamed", { name: DEMO_OWNER.name }) })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem")).toHaveCount(5);
  await shoot(page, "recent-sign-ins-admin");
  await page.context().close();
});
