import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "./validation";

function describedText(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "");
}

describe("passwordStrength", () => {
  it("rates by length first, then by the mix of characters", () => {
    expect(passwordStrength("").level).toBe("empty");
    expect(passwordStrength("a".repeat(MIN_PASSWORD_LENGTH - 1))).toEqual({
      level: "short",
      length: MIN_PASSWORD_LENGTH - 1,
    });
    expect(passwordStrength("a".repeat(MIN_PASSWORD_LENGTH)).level).toBe("fair");
    expect(passwordStrength("a".repeat(16)).level).toBe("fair");
    expect(passwordStrength("Abcdefghijklmn12").level).toBe("strong");
    // Length alone never makes it strong; the top level needs a mix of characters.
    expect(passwordStrength("a".repeat(64)).level).toBe("fair");
    expect(passwordStrength("abcdefghijklmnop12").level).toBe("fair");
  });

  it("counts characters as the server does", () => {
    // Eleven characters outside the BMP are 22 UTF-16 units but still too short.
    expect(passwordStrength("\u{1D400}".repeat(11)).level).toBe("short");
  });
});

describe("sign-in page", () => {
  it("shows and hides the password with a toggle named after what it does", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    const password = await screen.findByLabelText("Password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(password.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-controls")).toBe(password.id);
    expect(toggle.hasAttribute("title")).toBe(false);

    await user.click(toggle);
    expect(password.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-label")).toBe("Hide password");
    await user.click(toggle);
    expect(password.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-label")).toBe("Show password");
  });

  it("hides a shown password again when the form is sent", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    await user.click(await screen.findByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    const password = screen.getByLabelText("Password");
    await user.click(password);
    await user.paste("wrong password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.getAttribute("type")).toBe("text");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(password.getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("hides a shown password again when the page is hidden", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    const password = await screen.findByLabelText("Password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.getAttribute("type")).toBe("text");
    fireEvent(window, new Event("pagehide"));
    await waitFor(() => expect(password.getAttribute("type")).toBe("password"));
  });

  it("warns about Caps Lock while it is on, linked to the field", async () => {
    installFakeServer();
    renderApp("/login");
    const password = await screen.findByLabelText("Password");
    fireEvent.keyDown(password, { key: "A", modifierCapsLock: true });
    expect(screen.getByText("Caps Lock is on.")).toBeTruthy();
    expect(describedText(password)).toContain("Caps Lock is on.");

    fireEvent.keyUp(password, { key: "CapsLock", modifierCapsLock: false });
    expect(screen.queryByText("Caps Lock is on.")).toBeNull();
    fireEvent.keyDown(password, { key: "A", modifierCapsLock: true });
    fireEvent.blur(password);
    expect(screen.queryByText("Caps Lock is on.")).toBeNull();
  });

  it("confirms a sign-out until the next attempt", async () => {
    installFakeServer();
    const { user } = renderApp("/login?signedOut=true");
    const notice = await screen.findByText("You have signed out.");
    // Inside a status region that was there before the text, so it is announced.
    expect(notice.closest('[role="status"]')).toBeTruthy();

    await user.click(screen.getByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste("wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Email address or password is not correct.");
    expect(screen.queryByText("You have signed out.")).toBeNull();
  });

  it("asks the server not to remember a browser that is not the user's", async () => {
    const server = installFakeServer({ signedIn: false });
    const { user } = renderApp("/login");
    await user.click(await screen.findByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    const notMine = screen.getByRole("checkbox", { name: /This is not my browser/ });
    expect((notMine as HTMLInputElement).checked).toBe(false);
    await user.click(notMine);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.path === "/api/auth/login")?.body).toEqual({
        email: TEST_USER.email,
        password: TEST_PASSWORD,
        forgetBrowser: true,
      }),
    );
  });

  it("leaves the browser remembered by default", async () => {
    const server = installFakeServer({ signedIn: false });
    const { user } = renderApp("/login");
    await user.click(await screen.findByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(server.calls.find((call) => call.path === "/api/auth/login")?.body).toEqual({
        email: TEST_USER.email,
        password: TEST_PASSWORD,
      }),
    );
  });

  it("shows no sign-out confirmation on a plain visit", async () => {
    installFakeServer();
    renderApp("/login");
    await screen.findByLabelText("Password");
    expect(screen.queryByText("You have signed out.")).toBeNull();
  });
});
