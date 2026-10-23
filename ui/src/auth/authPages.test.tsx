import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
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
    expect(passwordStrength("a".repeat(20)).level).toBe("strong");
  });

  it("counts characters as the server does", () => {
    // Eleven characters outside the BMP are 22 UTF-16 units but still too short.
    expect(passwordStrength("\u{1D400}".repeat(11)).level).toBe("short");
  });
});

describe("sign-in page", () => {
  it("shows and hides the password with a toggle that keeps its name", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    const password = await screen.findByLabelText("Password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(password.getAttribute("type")).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(password.id);

    await user.click(toggle);
    expect(password.getAttribute("type")).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.click(toggle);
    expect(password.getAttribute("type")).toBe("password");
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
    const notice = await screen.findByText("You signed out.");
    expect(notice.closest('[role="status"]')).toBeTruthy();

    await user.click(screen.getByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste("wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Email address or password is incorrect.");
    expect(screen.queryByText("You signed out.")).toBeNull();
  });

  it("shows no sign-out confirmation on a plain visit", async () => {
    installFakeServer();
    renderApp("/login");
    await screen.findByLabelText("Password");
    expect(screen.queryByText("You signed out.")).toBeNull();
  });
});

describe("setup page", () => {
  it("groups the fields in three named steps", async () => {
    installFakeServer({ setupNeeded: true });
    renderApp("/setup");
    expect(await screen.findByRole("group", { name: "Confirm this server" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Name the organization" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Create the owner account" })).toBeTruthy();
  });

  it("rates the new password while it is typed, next to the rule", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    const password = await screen.findByLabelText("Password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(describedText(password)).toEqual(["At least 12 characters."]);

    await user.type(password, "abcde");
    expect(describedText(password)).toContain("Too short: 5 of 12 characters.");
    await user.type(password, "fghijkl");
    expect(describedText(password)).toContain("Long enough. More length makes it stronger.");
    await user.type(password, "MNO-9");
    expect(describedText(password)).toContain("Strong password.");
  });
});
