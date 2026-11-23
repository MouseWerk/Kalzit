import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { sampleProvider } from "../features/admin/sso/test/fakeSso";
import { invitationInfo } from "../test/fakeMail";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

/** One anatomy for every page before the app (board Auth.dc.html, frames 2, 4, 10 and 14). */

const TOKEN = "t".repeat(43);

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("the frame of the pages before the app", () => {
  it("reaches the form first: a skip link, then the page, then language, theme and help", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    const email = await screen.findByLabelText("Email address");
    const skip = screen.getByRole("button", { name: "Skip to content" });
    const language = screen.getByRole("button", { name: "Language: English" });
    const help = screen.getByRole("link", { name: "Help" });
    const form = screen.getByRole("form", { name: "Sign in" });
    // The source order is the keyboard's order.
    expect(skip.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.compareDocumentPosition(language) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(language.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The first Tab stop is the skip link; it leads into the page.
    await user.tab();
    expect(document.activeElement).toBe(skip);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("main"));
    await user.tab();
    expect(document.activeElement).toBe(email);
  });

  it("has one heading per page and no card around the form", async () => {
    installFakeServer();
    renderApp("/login");
    await screen.findByLabelText("Email address");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const form = screen.getByRole("form", { name: "Sign in" });
    expect(form.className).toBe("access__form");
  });

  it("fills in for password managers with the right autocomplete names", async () => {
    installFakeServer();
    renderApp("/login");
    const email = await screen.findByLabelText("Email address");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("name")).toBe("email");
    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("name")).toBe("password");
    // Never a placeholder in place of a label: the fields have visible labels above them.
    expect(screen.getByText("Email address", { selector: "label" })).toBeTruthy();
  });

  it("shows an unknown address in the frame, with help and the product's own name", async () => {
    const server = installFakeServer();
    server.state.branding = { ...server.state.branding, productName: "Sunstone Insights" };
    renderApp("/no-such-page");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Help" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Language:/ })).toBeTruthy();
    await waitFor(() => expect(document.title).toBe("Page not found – Sunstone Insights"));
  });
});

describe("sign-in messages and end states", () => {
  it("says so when the providers could not be loaded, and keeps the password form", async () => {
    installFakeServer();
    // Every request for the list fails, the route's and the page's alike.
    const answer = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).includes("/api/auth/providers")
        ? Promise.resolve(Response.json({ error: { code: "internal" } }, { status: 500 }))
        : answer(input, init);
    renderApp("/login");
    const notice = await screen.findByText(
      "Sign-in through providers cannot be reached right now.",
    );
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("keeps what was typed when the server does not answer", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email address"), TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    server.state.offline = true;
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByText("The server is not answering right now.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByText("What you entered stays. Try again in a moment.")).toBeTruthy();
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
      TEST_USER.email,
    );
  });

  it("shows an account locked by admins as a page, not as a form that cannot work", async () => {
    const server = installFakeServer();
    server.areas.sso.providers = [sampleProvider()];
    const { user } = renderApp("/login?sso=disabled&provider=mueller-sso");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your account is locked" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "An admin of your organization can unlock it. It has nothing to do with your password.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Sign in with another account" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });

  it("names the pause after too many attempts a pause, never a lock", async () => {
    const server = installFakeServer();
    server.rateLimitNext("/api/auth/login", 120);
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email address"), TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toContain("pause"));
    expect(alert.textContent).toContain("This is a pause, not a lock.");
    expect(alert.textContent).not.toMatch(/locked until/i);
  });
});

describe("invitation with a provider", () => {
  it("puts the provider first as the main action and folds the password form", async () => {
    const server = installFakeServer();
    server.areas.mail.links[TOKEN] = invitationInfo({
      sso: [{ id: "mueller-sso", name: "Müller SSO" }],
    });
    const { user } = renderApp(`/invite#${TOKEN}`);
    const provider = await screen.findByRole("link", { name: "Continue with Müller SSO" });
    expect(provider.className).toContain("button--primary");
    expect(screen.queryByLabelText("Your name")).toBeNull();
    const open = screen.getByRole("button", { name: "Create account with a password" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await user.click(open);
    const name = await screen.findByLabelText("Your name");
    expect(document.activeElement).toBe(name);
    // The form stands open below: the provider is no longer the main action, the form's is.
    expect(provider.className).not.toContain("button--primary");
    expect(screen.getByRole("button", { name: "Accept invitation" }).className).toContain(
      "button--primary",
    );
    const address = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(address.readOnly).toBe(true);
    expect(address.getAttribute("autocomplete")).toBe("username");
  });
});
