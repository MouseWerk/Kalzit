import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { invitationInfo } from "../test/fakeMail";
import { installFakeServer } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

const TOKEN = "t".repeat(43);
const NEW_PASSWORD = "a new password for 2026";

beforeEach(() => window.sessionStorage.clear());

function posted(server: ReturnType<typeof installFakeServer>, path: string) {
  return server.calls.filter((call) => call.method === "POST" && call.path === path);
}

describe("invitation page", () => {
  it("shows the invitation and makes the account with name and password", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo();
    const { user, location } = renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome to Kalzit" }),
    ).toBeTruthy();
    expect(
      screen.getByText("You are invited to the organization Analytical Engines."),
    ).toBeTruthy();
    // The facts of the invitation as one card: who invited, role, team, until when.
    const facts = screen.getByText("Invited by").closest("dl") as HTMLElement;
    expect(within(facts).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(facts).getByText("Editor")).toBeTruthy();
    expect(within(facts).getByText("Analysts")).toBeTruthy();
    expect(within(facts).getByText("Valid until")).toBeTruthy();
    // The token leaves the address at once.
    await waitFor(() => expect(location().hash).toBe(""));
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
      "nora@example.com",
    );

    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("Enter your name.")).toBeTruthy();
    expect(posted(server, "/api/auth/invitation/accept")).toHaveLength(0);

    await user.type(screen.getByLabelText("Your name"), "Nora Becker");
    await user.type(screen.getByLabelText("Password"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    await screen.findByRole("navigation", { name: "Main navigation" });
    expect(posted(server, "/api/auth/invitation/accept")[0]?.body).toEqual({
      token: TOKEN,
      name: "Nora Becker",
      password: NEW_PASSWORD,
    });
  });

  it("sets up a required second factor before the new account is signed in", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo();
    server.areas.mail.acceptSecondFactor = {
      email: "nora@example.com",
      setup: true,
      methods: [],
      lastUsed: null,
      allowed: { passkey: false, totp: true },
      requiredBy: { kind: "org", id: "o1", name: "Analytical Engines" },
      lockedUntil: null,
      expiresAt: Date.now() + 600_000,
    };
    const { user } = renderApp(`/invite#${TOKEN}`);
    await screen.findByRole("heading", { level: 1, name: "Welcome to Kalzit" });
    await user.type(screen.getByLabelText("Your name"), "Nora Becker");
    await user.type(screen.getByLabelText("Password"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    // The setup of the sign-in's second step, not the app.
    await waitFor(() => expect(server.state.signedIn).toBe(false));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull(),
    );
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.getAllByText(/Analytical Engines/).length).toBeGreaterThan(0);
  });

  it("goes on to sign-in when the second step cannot be read", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo();
    server.areas.mail.acceptSecondFactor = { unexpected: true };
    const { user, location } = renderApp(`/invite#${TOKEN}`);
    await user.type(await screen.findByLabelText("Your name"), "Nora Becker");
    await user.type(screen.getByLabelText("Password"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(location().pathname).toBe("/login"));
  });

  it("offers only the provider when password sign-in is off", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({
      password: false,
      sso: [{ id: "mueller-sso", name: "Müller SSO" }],
    });
    renderApp(`/invite#${TOKEN}`);
    const button = await screen.findByRole("link", { name: "Continue with Müller SSO" });
    expect(button.getAttribute("href")).toBe("/api/auth/sso/mueller-sso/start?returnTo=%2Finvite");
    expect(screen.getByText(/you sign in through your provider/)).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
  });

  it("names the day an expired invitation ended and who to ask", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ state: "expired" });
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This invitation has expired" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /^It was valid until .+\. Ask Ada Lovelace or another admin for a new one\.$/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });

  it("answers revoked and unknown links alike", async () => {
    installFakeServer();
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link no longer works" }),
    ).toBeTruthy();
  });

  it("says when it was accepted already", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ state: "accepted" });
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This invitation was accepted already",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });

  it("asks someone with an account to sign in first, keeping the link", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ accountExists: true });
    const { user, location } = renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "You already have an account" }),
    ).toBeTruthy();
    expect(screen.getByText("Sign in, then you join Analytical Engines.")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Sign in and join" }));
    await waitFor(() => expect(location().pathname).toBe("/login"));
    expect(window.sessionStorage.getItem("kalzit.link.invite")).toBe(TOKEN);
  });

  it("sets up the second factor the organization requires before a signed-in account joins", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.mail.links[TOKEN] = invitationInfo({
      signedInAs: { name: "Nora Becker", email: "nora@example.com" },
    });
    server.areas.mail.acceptSecondFactor = {
      email: "nora@example.com",
      setup: true,
      methods: [],
      lastUsed: null,
      allowed: { passkey: false, totp: true },
      requiredBy: { kind: "org", id: "o1", name: "Analytical Engines" },
      lockedUntil: null,
      expiresAt: Date.now() + 600_000,
    };
    const { user } = renderApp(`/invite#${TOKEN}`);
    await user.click(await screen.findByRole("button", { name: "Accept and join" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Join" })).toBeNull());
    expect(server.state.signedIn).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.getAllByText(/Analytical Engines/).length).toBeGreaterThan(0);
  });

  it("says whom to ask when neither a password nor a provider can be used", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ password: false, sso: [] });
    renderApp(`/invite#${TOKEN}`);
    expect(await screen.findByText("There is no way to sign in here right now.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("refuses to join with another signed-in account until it signs out", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.mail.links[TOKEN] = invitationInfo({
      signedInAs: { name: "Paul Weber", email: "paul@example.com" },
    });
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "The invitation is for another account",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You are signed in as paul@example.com. The invitation is for nora@example.com.",
      ),
    ).toBeTruthy();
    // Both ways weigh the same; neither is the main action.
    const signOut = screen.getByRole("button", { name: "Sign out and accept" });
    const cancel = screen.getByRole("link", { name: "Cancel" });
    expect(signOut.className).toBe(cancel.className);
    expect(signOut.classList.contains("button--primary")).toBe(false);
  });
});

describe("password reset page", () => {
  it("asks for a link and answers the same for every address", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/reset-password");
    expect(await screen.findByRole("heading", { level: 1, name: "Reset password" })).toBeTruthy();
    await user.type(screen.getByLabelText("Email address"), "lea@example.com");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Check your inbox" })).toBeTruthy();
    expect(
      screen.getByText(
        "If there is an account with a password for lea@example.com, a link arrives there shortly. It works for 60 minutes; check the spam folder too.",
      ),
    ).toBeTruthy();
    const again = screen.getByRole("button", { name: /^Next try in (1:00|0:5\d)$/ });
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(server.areas.mail.resetRequests).toEqual(["lea@example.com"]);
  });

  it("says who can help when the server sends no mail", async () => {
    const server = installFakeServer();
    server.areas.mail.resetAvailable = false;
    renderApp("/reset-password");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Here only admins reset passwords" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This server does not send email. An admin of your organization can reset your password.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send link" })).toBeNull();
  });

  it("sets the new password with the link, always signing out elsewhere", async () => {
    const server = installFakeServer();
    server.areas.mail.resets[TOKEN] = {
      email: "lea@example.com",
      expiresAt: Date.now() + 3_600_000,
    };
    const { user } = renderApp(`/reset-password#${TOKEN}`);
    // The account's address as a visible, locked field, so password managers store it too.
    const address = (await screen.findByLabelText("Email address")) as HTMLInputElement;
    expect(address.value).toBe("lea@example.com");
    expect(address.readOnly).toBe(true);
    expect(address.getAttribute("autocomplete")).toBe("username");
    expect(
      screen.getByLabelText("New password", { selector: "input" }).getAttribute("autocomplete"),
    ).toBe("new-password");
    // No way to keep the other sessions: the page says they end.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("This ends every other session of your account.")).toBeTruthy();
    await user.type(screen.getByLabelText("New password", { selector: "input" }), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your password is changed" }),
    ).toBeTruthy();
    expect(server.areas.mail.completed).toEqual([{ token: TOKEN, password: NEW_PASSWORD }]);
  });

  it("offers a new link when the link no longer works", async () => {
    installFakeServer();
    const { user } = renderApp(`/reset-password#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link no longer works" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(await screen.findByRole("button", { name: "Send link" })).toBeTruthy();
  });
});
