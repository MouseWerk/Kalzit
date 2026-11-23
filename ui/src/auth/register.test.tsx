import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeServer } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

const TOKEN = "r".repeat(43);
const PASSWORD = "a new password for 2026";

beforeEach(() => window.sessionStorage.clear());

function offering() {
  const server = installFakeServer();
  Object.assign(server.areas.server075.registration, {
    available: true,
    allowedDomains: ["example.com", "partner.example"],
  });
  return server;
}

const posted = (server: ReturnType<typeof installFakeServer>, path: string) =>
  server.calls.filter((call) => call.method === "POST" && call.path === path);

describe("self-registration for visitors", () => {
  it("is not offered on the sign-in page while the server does not offer it", async () => {
    installFakeServer();
    renderApp("/login");
    expect(await screen.findByText(/ask an admin of your organization/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create account" })).toBeNull();
  });

  it("is offered on the sign-in page while the server offers it", async () => {
    offering();
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("link", { name: "Create account" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Create account" })).toBeTruthy();
    expect(screen.getByText("With an address of example.com or partner.example.")).toBeTruthy();
  });

  it("asks for a link with the address alone and says the same for every address", async () => {
    const server = offering();
    const { user } = renderApp("/register");
    const email = await screen.findByLabelText("Email address");
    // "username", so password managers file the new account under this address.
    expect(email.getAttribute("autocomplete")).toBe("username");
    await user.type(email, "jonas@example.com");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeTruthy();
    // The page does not say whether the address may register or has an account already.
    expect(screen.getByText(/If jonas@example.com may create an account/)).toBeTruthy();
    expect(posted(server, "/api/auth/registration")[0]?.body).toEqual({
      email: "jonas@example.com",
      language: "en",
    });
    // Sending again waits a minute.
    const again = screen.getByRole("button", { name: /Send again in \d+ s/ });
    expect(again.getAttribute("aria-disabled")).toBe("true");
    await user.click(again);
    expect(posted(server, "/api/auth/registration")).toHaveLength(1);
  });

  it("offers the link again after the wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const server = offering();
      const { user } = renderApp("/register");
      await user.type(await screen.findByLabelText("Email address"), "jonas@example.com");
      await user.click(screen.getByRole("button", { name: "Send link" }));
      await screen.findByRole("heading", { name: "Check your inbox" });
      for (let second = 0; second < 61; second++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      await user.click(await screen.findByRole("button", { name: "Send again" }));
      await waitFor(() => expect(posted(server, "/api/auth/registration")).toHaveLength(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("says at the field that a domain may not register", async () => {
    const server = offering();
    const { user } = renderApp("/register");
    const email = await screen.findByLabelText("Email address");
    await user.type(email, "mira@mail.example");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(
      await screen.findByText(
        "With this domain you cannot create an account here. Ask for an invitation.",
      ),
    ).toBeTruthy();
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(server.areas.server075.registration.started).toEqual([]);
    // An address that is none is caught before anything is sent.
    await user.clear(email);
    await user.type(email, "mira");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect(posted(server, "/api/auth/registration")).toHaveLength(1);
  });

  it("says calmly when there were too many attempts", async () => {
    const server = offering();
    server.failNext("/api/auth/registration", 429, "rate_limited", "POST");
    const { user } = renderApp("/register");
    await user.type(await screen.findByLabelText("Email address"), "jonas@example.com");
    await user.click(screen.getByRole("button", { name: "Send link" }));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(screen.queryByRole("heading", { name: "Check your inbox" })).toBeNull();
  });

  it("says that no accounts are created here when registration is off", async () => {
    installFakeServer();
    renderApp("/register");
    expect(
      await screen.findByRole("heading", { name: "Accounts are not created here by yourself" }),
    ).toBeTruthy();
    expect(screen.getByText("Ask an admin of your organization for an invitation.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });

  it("chooses name and password behind the link, then waits for approval", async () => {
    const server = offering();
    const { user, location } = renderApp(`/register#${TOKEN}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Name and password" }),
    ).toBeTruthy();
    expect(screen.getByText("Your address is confirmed.")).toBeTruthy();
    // The token leaves the address at once.
    await waitFor(() => expect(location().hash).toBe(""));
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter your name.")).toBeTruthy();
    expect(posted(server, "/api/auth/registration/confirm")).toHaveLength(0);
    await user.type(screen.getByLabelText("Your name"), "Jonas Keller");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByRole("heading", { name: "Your account awaits approval" }),
    ).toBeTruthy();
    // Who approves, what happens then, and when the request expires.
    expect(
      screen.getByText(
        "An admin approves it; you then get an email. Without approval the request expires after 14 days.",
      ),
    ).toBeTruthy();
    expect(posted(server, "/api/auth/registration/confirm")[0]?.body).toEqual({
      token: TOKEN,
      name: "Jonas Keller",
      password: PASSWORD,
    });
  });

  it("says the account is ready where no approval is needed", async () => {
    const server = offering();
    server.areas.server075.registration.confirm = "approved";
    const { user } = renderApp(`/register#${TOKEN}`);
    await user.type(await screen.findByLabelText("Your name"), "Jonas Keller");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Your account is ready" })).toBeTruthy();
  });

  it("says a used or expired link is gone and offers a new one", async () => {
    const server = offering();
    server.areas.server075.registration.confirm = {
      status: 404,
      code: "not_found",
      reason: "signup.invalid_link",
    };
    const { user } = renderApp(`/register#${TOKEN}`);
    await user.type(await screen.findByLabelText("Your name"), "Jonas Keller");
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This link is used or older than 24 hours.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(await screen.findByLabelText("Email address")).toBeTruthy();
  });
});
