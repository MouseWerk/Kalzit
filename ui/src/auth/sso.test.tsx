import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sampleLdapProvider, sampleProvider } from "../features/admin/sso/test/fakeSso";
import { leavePage } from "../lib/leavePage";
import { type FakeServer, installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

function withProviders(server: FakeServer) {
  server.areas.sso.providers = [
    sampleProvider(),
    sampleProvider({ id: "p2", slug: "partner", name: "Partner Portal", position: 1 }),
  ];
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("sign-in with identity providers", () => {
  it("shows the providers first, the first one as the main button, and folds the password form", async () => {
    const server = installFakeServer();
    withProviders(server);
    const { user } = renderApp("/login?redirect=%2Fdashboards");
    const first = await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    const second = screen.getByRole("link", { name: "Sign in with Partner Portal" });
    expect(first.className).toContain("button--primary");
    expect(second.className).toContain("button--secondary");
    expect(first.getAttribute("href")).toBe(
      "/api/auth/sso/mueller-sso/start?returnTo=%2Fdashboards",
    );
    expect(screen.queryByLabelText("Email address")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign in with password" }));
    const email = screen.getByLabelText("Email address");
    expect(document.activeElement).toBe(email);
    expect(window.localStorage.getItem("kalzit.signIn.passwordOpen")).toBe("true");
    // The submit button is not the main button while the providers' buttons stand above it.
    expect(screen.getByRole("button", { name: "Sign in" }).className).not.toContain(
      "button--primary",
    );
  });

  it("shows the open form below the buttons and moves the main button to it", async () => {
    const server = installFakeServer();
    withProviders(server);
    server.areas.sso.passwordForm = "expanded";
    renderApp("/login");
    const first = await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    expect(first.className).toContain("button--secondary");
    expect(screen.getByText("or with password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("button--primary");
  });

  it("leaves no password form when the server hides it", async () => {
    const server = installFakeServer();
    withProviders(server);
    server.areas.sso.passwordForm = "hidden";
    renderApp("/login");
    await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    expect(screen.queryByRole("button", { name: "Sign in with password" })).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("goes on to the provider in this tab and says so on the button", async () => {
    const server = installFakeServer();
    withProviders(server);
    const go = vi.spyOn(leavePage, "go").mockImplementation(() => {});
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("link", { name: "Sign in with Müller SSO" }));
    expect(go).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/sso\/mueller-sso\/start\?returnTo=%2F$/),
    );
    expect(screen.getByRole("link", { name: "Continuing to Müller SSO…" })).toBeTruthy();
  });

  it("shows why the provider sign-in failed, with the error id, back on the sign-in page", async () => {
    const server = installFakeServer();
    withProviders(server);
    const { location } = renderApp("/anmelden?sso=unavailable&provider=mueller-sso&ref=7Q2K-91XD");
    const title = await screen.findByText("Müller SSO is not answering right now.");
    expect(title.closest('[role="alert"]')).not.toBeNull();
    expect(
      screen.getByText(
        "Try again in a few minutes or sign in another way. Error ID 7Q2K-91XD for your admins.",
      ),
    ).toBeTruthy();
    expect(location().pathname).toBe("/login");
    // The buttons stay below the message.
    expect(screen.getByRole("link", { name: "Sign in with Müller SSO" })).toBeTruthy();
  });

  it("ignores an outcome it does not know", async () => {
    const server = installFakeServer();
    withProviders(server);
    renderApp("/anmelden?sso=%3Cscript%3E&provider=mueller-sso");
    await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
  });

  it("says that password sign-in is off for the account, only after the right password", async () => {
    const server = installFakeServer();
    withProviders(server);
    server.areas.sso.passwordForm = "expanded";
    server.areas.sso.passwordOff.add(TEST_USER.email);
    const { user } = renderApp("/login");
    await user.click(await screen.findByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("Password sign-in is turned off for your account."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Sign in with Müller SSO. Only the break-glass admin still uses a password here.",
      ),
    ).toBeTruthy();
    expect(server.state.signedIn).toBe(false);
  });

  it("lets the break-glass admin in at /anmelden/lokal while password sign-in is off", async () => {
    const server = installFakeServer();
    withProviders(server);
    server.areas.sso.localPassword = "off";
    server.areas.sso.breakGlass = {
      userId: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
    };
    const { user, location } = renderApp("/anmelden/lokal");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in with password" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with Müller SSO" })).toBeNull();
    await user.click(screen.getByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(location().pathname).toBe("/"));
    expect(
      server.calls.some((call) => call.method === "POST" && call.path === "/api/auth/login/local"),
    ).toBe(true);
  });

  it("ends a test sign-in in its own window", async () => {
    installFakeServer();
    const close = vi.spyOn(leavePage, "close").mockImplementation(() => {});
    renderApp("/anmelden/sso-test");
    expect(
      await screen.findByText("Test sign-in finished. You can close this window."),
    ).toBeTruthy();
    expect(close).toHaveBeenCalled();
  });
});

describe("sign-in with an LDAP directory", () => {
  async function signInAs(login: string) {
    const { user, location } = renderApp("/login");
    const field = await screen.findByLabelText("Email or username");
    expect(
      screen.getByText("An account from the directory Verzeichnis Zentrale or a local account."),
    ).toBeTruthy();
    await user.click(field);
    await user.paste(login);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    return { user, location };
  }

  it("asks for an email or user name in the open form, without a button for the directory", async () => {
    const server = installFakeServer();
    server.areas.sso.providers = [sampleLdapProvider()];
    const { location } = await signInAs("l.hoffmann");
    expect(screen.queryByRole("link", { name: /Verzeichnis Zentrale/ })).toBeNull();
    await waitFor(() => expect(location().pathname).toBe("/"));
    expect(server.state.signedIn).toBe(true);
  });

  it("keeps the form for directory accounts next to the provider buttons", async () => {
    const server = installFakeServer();
    server.areas.sso.providers = [sampleProvider(), sampleLdapProvider({ position: 1 })];
    server.areas.sso.passwordForm = "hidden";
    server.areas.sso.localPassword = "off";
    const { user } = renderApp("/login");
    await screen.findByRole("link", { name: "Sign in with Müller SSO" });
    expect(screen.queryByRole("link", { name: /Verzeichnis Zentrale/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in with password" }));
    expect(screen.getByLabelText("Email or username")).toBeTruthy();
  });

  it("says when the directory is not answering", async () => {
    const server = installFakeServer();
    server.areas.sso.providers = [sampleLdapProvider()];
    server.areas.sso.directoryAnswer = "unreachable";
    await signInAs("l.hoffmann");
    expect(
      await screen.findByText("The directory Verzeichnis Zentrale is not answering right now."),
    ).toBeTruthy();
  });

  it("says why the directory account is refused, with the error id", async () => {
    const server = installFakeServer();
    server.areas.sso.providers = [sampleLdapProvider()];
    server.areas.sso.directoryAnswer = { outcome: "unmapped", ref: "7Q2K-91XD" };
    await signInAs("l.hoffmann");
    expect(await screen.findByText("There is no access here for your account.")).toBeTruthy();
    expect(screen.getByText(/Error ID 7Q2K-91XD for your admins\.$/)).toBeTruthy();
    expect(server.state.signedIn).toBe(false);
  });
});
