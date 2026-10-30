import { screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByText("Ada Lovelace invites you to Analytical Engines.")).toBeTruthy();
    expect(screen.getByText(/^Role Editor · Team Analysts · valid until/)).toBeTruthy();
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

  it("names the day an expired invitation ended and who to ask", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ state: "expired" });
    renderApp(`/invite#${TOKEN}`);
    expect(await screen.findByText(/^This invitation expired on /)).toBeTruthy();
    expect(screen.getByText(/Ask Ada Lovelace or another admin for a new one\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });

  it("answers revoked and unknown links alike", async () => {
    installFakeServer();
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link no longer works." }),
    ).toBeTruthy();
  });

  it("says when it was accepted already", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ state: "accepted" });
    renderApp(`/invite#${TOKEN}`);
    expect(await screen.findByText("This invitation was accepted already.")).toBeTruthy();
  });

  it("asks someone with an account to sign in first, keeping the link", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({ accountExists: true });
    const { user, location } = renderApp(`/invite#${TOKEN}`);
    expect(await screen.findByText("You already have an account on this server.")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Sign in and join" }));
    await waitFor(() => expect(location().pathname).toBe("/login"));
    expect(window.sessionStorage.getItem("kalzit.link.invite")).toBe(TOKEN);
  });

  it("refuses to join with another signed-in account until it signs out", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.mail.links[TOKEN] = invitationInfo({
      signedInAs: { name: "Paul Weber", email: "paul@example.com" },
    });
    renderApp(`/invite#${TOKEN}`);
    expect(await screen.findByText("You are signed in as Paul Weber.")).toBeTruthy();
    expect(
      screen.getByText("The invitation is for nora@example.com. Sign out to accept it."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out and accept" })).toBeTruthy();
  });
});

describe("password reset page", () => {
  it("asks for a link and answers the same for every address", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/reset-password");
    expect(await screen.findByRole("heading", { level: 1, name: "Reset password" })).toBeTruthy();
    await user.type(screen.getByLabelText("Email address"), "lea@example.com");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Check your inbox." }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "If there is an account with a password for lea@example.com, a mail is on its way. The link works for 60 minutes.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Next try in 1:00|Next try in 0:5\d/)).toBeTruthy();
    expect(server.areas.mail.resetRequests).toEqual(["lea@example.com"]);
  });

  it("says who can help when the server sends no mail", async () => {
    const server = installFakeServer();
    server.areas.mail.resetAvailable = false;
    renderApp("/reset-password");
    expect(
      await screen.findByText("An admin of your organization can reset your password."),
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
    expect(await screen.findByText("For lea@example.com")).toBeTruthy();
    // No way to keep the other sessions: the page says they end.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("This ends every other session of your account.")).toBeTruthy();
    await user.type(screen.getByLabelText("New password", { selector: "input" }), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText("Your password is changed.")).toBeTruthy();
    expect(server.areas.mail.completed).toEqual([{ token: TOKEN, password: NEW_PASSWORD }]);
  });

  it("offers a new link when the link no longer works", async () => {
    installFakeServer();
    const { user } = renderApp(`/reset-password#${TOKEN}`);
    expect(await screen.findByText("This link no longer works.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(await screen.findByRole("button", { name: "Send link" })).toBeTruthy();
  });
});
