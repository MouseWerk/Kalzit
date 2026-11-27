import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleProvider } from "../features/admin/sso/test/fakeSso";
import { type FakeServer, installFakeServer } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

/** What the browser's `navigator.credentials.get` was asked, and how it answers. */
interface FakeBrowser {
  requests: CredentialRequestOptions[];
  /** The next dialog of the button: a passkey, or the person closing it. */
  answer: "passkey" | "cancel" | "wait";
  /** Picks a passkey from the suggestion in the address field that is waiting. */
  pickSuggestion: () => void;
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fakeCredential() {
  return {
    id: "Y3JlZA",
    rawId: bytes("cred"),
    type: "public-key",
    response: {
      authenticatorData: bytes("auth"),
      clientDataJSON: bytes("{}"),
      signature: bytes("sig"),
      userHandle: bytes("user"),
    },
    getClientExtensionResults: () => ({}),
  };
}

const abortError = () => new DOMException("aborted", "AbortError");

/** A browser with passkeys: a secure context, WebAuthn and the suggestion in address fields. */
function installPasskeys(options: { suggestions?: boolean } = {}): FakeBrowser {
  let pick: (() => void) | null = null;
  const browser: FakeBrowser = {
    requests: [],
    answer: "passkey",
    pickSuggestion: () => pick?.(),
  };
  const get = vi.fn((request: CredentialRequestOptions) => {
    browser.requests.push(request);
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(abortError()));
      if (request.mediation === "conditional") {
        pick = () => resolve(fakeCredential());
        return;
      }
      if (browser.answer === "passkey") {
        resolve(fakeCredential());
      } else if (browser.answer === "cancel") {
        reject(new DOMException("closed", "NotAllowedError"));
      }
    });
  });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal(
    "PublicKeyCredential",
    Object.assign(() => {}, {
      isConditionalMediationAvailable: () => Promise.resolve(options.suggestions ?? true),
    }),
  );
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { get, create: vi.fn() },
  });
  return browser;
}

function withPasskeys(server: FakeServer) {
  server.areas.sso.passkeySignIn = true;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "credentials");
});

describe("signing in with a passkey alone", () => {
  it("offers nothing of it while the server does not", async () => {
    installPasskeys();
    installFakeServer({ signedIn: false });
    renderApp("/login");
    const email = await screen.findByLabelText("Email address");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
    expect(email.getAttribute("autocomplete")).toBe("username");
  });

  it("offers nothing of it in a browser without passkeys", async () => {
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    renderApp("/login");
    await screen.findByLabelText("Email address");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });

  it("puts the passkey first and lets the address field suggest saved passkeys", async () => {
    installPasskeys();
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    renderApp("/login");
    const button = await screen.findByRole("button", { name: "Sign in with a passkey" });
    expect(button.className).toContain("button--primary");
    expect(screen.getByRole("button", { name: "Sign in" }).className).not.toContain(
      "button--primary",
    );
    const email = screen.getByLabelText("Email address");
    await waitFor(() => expect(email.getAttribute("autocomplete")).toBe("username webauthn"));
    expect(screen.getByText("Your browser also suggests saved passkeys here.")).toBeTruthy();
    // The suggestion waits in the address field with a dialog of the server's.
    await waitFor(() => expect(server.areas.sso.passkeyStarts).toBe(1));
  });

  it("keeps the address field as it was where the browser cannot suggest passkeys", async () => {
    installPasskeys({ suggestions: false });
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    renderApp("/login");
    await screen.findByRole("button", { name: "Sign in with a passkey" });
    expect(screen.getByLabelText("Email address").getAttribute("autocomplete")).toBe("username");
    expect(screen.queryByText("Your browser also suggests saved passkeys here.")).toBeNull();
    expect(server.areas.sso.passkeyStarts).toBe(0);
  });

  it("signs in with the button's dialog, as a shared computer when ticked", async () => {
    const browser = installPasskeys({ suggestions: false });
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    const { user, location } = renderApp("/login?redirect=%2Fdashboards");
    await user.click(await screen.findByRole("checkbox", { name: "Shared or borrowed computer" }));
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards"));
    expect(browser.requests).toHaveLength(1);
    expect(browser.requests[0]?.mediation).toBeUndefined();
    const sent = server.areas.sso.passkeyAnswers[0];
    expect(sent?.forgetBrowser).toBe(true);
    expect((sent?.credential as { rawId?: string }).rawId).toBe("Y3JlZA");
    expect(server.state.signedIn).toBe(true);
  });

  it("says quietly that nothing happened when the dialog is closed", async () => {
    const browser = installPasskeys({ suggestions: false });
    browser.answer = "cancel";
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    const title = await screen.findByText("That did not work with the passkey.");
    expect(screen.getByText("Nothing happened. Try again or use your password.")).toBeTruthy();
    // No error tint: nothing is broken.
    expect(title.closest(".access-notice")?.className).toContain("access-notice--info");
    expect(server.areas.sso.passkeyAnswers).toHaveLength(0);
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("waits for the browser's dialog and closes it on cancel", async () => {
    const browser = installPasskeys({ suggestions: false });
    browser.answer = "wait";
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    const waiting = await screen.findByText("Waiting for your passkey…");
    expect(waiting.closest('[role="status"]')).not.toBeNull();
    expect(screen.getByText("Confirm in the window of your browser or device.")).toBeTruthy();
    expect(screen.queryByLabelText("Email address")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("That did not work with the passkey.")).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("names no reason when the server refuses the passkey", async () => {
    installPasskeys({ suggestions: false });
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    server.areas.sso.passkeyAnswer = "refused";
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in with a passkey" }));
    const title = await screen.findByText("This passkey cannot sign you in here.");
    expect(title.closest('[role="alert"]')).not.toBeNull();
    expect(title.closest(".access-notice")?.className).toContain("access-notice--danger");
    expect(server.state.signedIn).toBe(false);
  });

  it("signs in with a passkey picked from the address field's suggestion", async () => {
    const browser = installPasskeys();
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    const { location } = renderApp("/login");
    await screen.findByRole("button", { name: "Sign in with a passkey" });
    await waitFor(() => expect(browser.requests[0]?.mediation).toBe("conditional"));
    browser.pickSuggestion();
    await waitFor(() => expect(location().pathname).toBe("/"));
    expect(server.areas.sso.passkeyAnswers).toHaveLength(1);
    expect(server.areas.sso.passkeyAnswers[0]?.forgetBrowser).toBeUndefined();
  });

  it("sets the suggestion aside while the button's dialog is open", async () => {
    const browser = installPasskeys();
    browser.answer = "wait";
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    const { user } = renderApp("/login");
    await waitFor(() => expect(browser.requests[0]?.mediation).toBe("conditional"));
    await user.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(browser.requests).toHaveLength(2));
    expect(browser.requests[0]?.signal?.aborted).toBe(true);
    expect(browser.requests[1]?.mediation).toBeUndefined();
  });

  it("stands next to the providers' buttons, not as the main action", async () => {
    installPasskeys({ suggestions: false });
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    server.areas.sso.providers = [sampleProvider()];
    renderApp("/login");
    const first = await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    const passkey = screen.getByRole("button", { name: "Sign in with a passkey" });
    expect(first.className).toContain("button--primary");
    expect(passkey.className).toContain("button--secondary");
    expect(passkey.closest(".access__sso")).not.toBeNull();
  });

  it("is not on the break-glass form", async () => {
    installPasskeys();
    const server = installFakeServer({ signedIn: false });
    withPasskeys(server);
    renderApp("/anmelden/lokal");
    await screen.findByLabelText("Email address");
    expect(screen.queryByRole("button", { name: "Sign in with a passkey" })).toBeNull();
  });
});
