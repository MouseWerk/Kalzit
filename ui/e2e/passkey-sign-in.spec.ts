import type { Page } from "@playwright/test";
import { Api, baseUrl, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";

/**
 * Signing in with a passkey alone (board Auth.dc.html, frame 5; docs/api/access.md, "Passkey
 * sign-in") against a virtual authenticator of Chromium (WebAuthn domain of the DevTools
 * protocol): a platform authenticator with discoverable credentials that verifies the person.
 * Passkeys need a host name, so these pages open the server as `localhost`, not by its address.
 */
test.skip(({ browserName }) => browserName !== "chromium", "virtual authenticators are Chromium's");

function local(path: string): string {
  return `${baseUrl().replace("127.0.0.1", "localhost")}${path}`;
}

async function addAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

/** The browser offers no suggestion in the address field, so only the button opens a dialog. */
async function withoutSuggestions(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window.PublicKeyCredential, "isConditionalMediationAvailable", {
      configurable: true,
      value: async () => false,
    });
  });
}

/**
 * Signs `email` in through the API in the page and adds a passkey of the virtual authenticator,
 * as the account page does; then signs out again.
 */
async function enrollPasskey(page: Page, email: string, password: string): Promise<void> {
  await page.goto(local("/login"));
  const result = await page.evaluate(
    async ({ email, password }) => {
      const post = async (path: string, body: unknown) => {
        const answer = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: answer.status, body: answer.status === 204 ? null : await answer.json() };
      };
      const b64 = (text: string) => {
        const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
      };
      const text = (buffer: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buffer)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      await post("/api/auth/login", { email, password });
      await post("/api/me/security/confirm/password", { password });
      const options = await post("/api/me/security/passkeys/setup", {});
      const key = options.body.publicKey;
      const created = (await navigator.credentials.create({
        publicKey: {
          ...key,
          challenge: b64(key.challenge),
          user: { ...key.user, id: b64(key.user.id) },
          excludeCredentials: [],
        },
      })) as PublicKeyCredential;
      const response = created.response as AuthenticatorAttestationResponse;
      const saved = await post("/api/me/security/passkeys", {
        name: "Virtual",
        credential: {
          id: created.id,
          rawId: text(created.rawId),
          type: created.type,
          response: {
            attestationObject: text(response.attestationObject),
            clientDataJSON: text(response.clientDataJSON),
          },
          extensions: {},
        },
      });
      await post("/api/auth/logout", {});
      return saved.status;
    },
    { email, password },
  );
  expect(result).toBe(201);
  await page.context().clearCookies();
}

test("signs in with a passkey alone, without a second step", async ({ page }) => {
  const owner = await Api.owner();
  const person = await owner.createMember(unique("Passkey"), "viewer");
  await owner.dispose();
  await addAuthenticator(page);
  await withoutSuggestions(page);
  await enrollPasskey(page, person.email, person.password);

  await page.goto(local("/login"));
  const button = page.getByRole("button", { name: t("access.passkey.button") });
  await expect(button).toHaveClass(/button--primary/);
  await button.click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  const me = await page.request.get(local("/api/me"));
  expect(((await me.json()) as { email: string }).email).toBe(person.email);
  const signIns = (await (await page.request.get(local("/api/me/sign-ins"))).json()) as {
    items: { method: string; current: boolean }[];
  };
  expect(signIns.items[0]).toMatchObject({ method: "passkey", current: true });
  // A normal session outlives the browser.
  const session = (await page.context().cookies()).find((c) => c.name === "kalzit_session");
  expect(session?.expires).toBeGreaterThan(Date.now() / 1000);
});

test("ends with the browser on a shared or borrowed computer", async ({ page }) => {
  const owner = await Api.owner();
  const person = await owner.createMember(unique("Shared"), "viewer");
  await owner.dispose();
  await addAuthenticator(page);
  await withoutSuggestions(page);
  await enrollPasskey(page, person.email, person.password);

  await page.goto(local("/login"));
  await page.getByRole("checkbox", { name: t("access.login.sharedComputer") }).check();
  await page.getByRole("button", { name: t("access.passkey.button") }).click();
  await expect(page.getByRole("navigation", { name: t("nav.label") })).toBeVisible();
  const cookies = await page.context().cookies();
  // A cookie of the browser session (no expiry), and no known device.
  expect(cookies.find((c) => c.name === "kalzit_session")?.expires).toBe(-1);
  expect(cookies.find((c) => c.name === "kalzit_device")).toBeUndefined();
});

test("lets the address field suggest saved passkeys", async ({ page }) => {
  await addAuthenticator(page);
  await page.goto(local("/login"));
  const email = page.getByLabel(t("access.login.email"));
  await expect(email).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.getByText(t("access.passkey.hint"))).toBeVisible();
});

test("offers no passkey where Kalzit is opened by an IP address", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel(t("access.login.email"))).toBeVisible();
  await expect(page.getByRole("button", { name: t("access.passkey.button") })).toHaveCount(0);
});
