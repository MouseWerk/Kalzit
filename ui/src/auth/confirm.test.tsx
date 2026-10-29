import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { openAdmin } from "../features/admin/test/openAdmin";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

const TOKEN = "c".repeat(43);

beforeEach(() => window.sessionStorage.clear());

describe("email confirmation", () => {
  it("confirms the address of the link at once", async () => {
    const server = installFakeServer();
    server.areas.mail.confirmations = [TOKEN];
    renderApp(`/confirm-email#${TOKEN}`);
    expect(await screen.findByText("Your email address is confirmed.")).toBeTruthy();
    expect(server.areas.mail.confirmations).toEqual([]);
  });

  it("says when the link no longer works", async () => {
    installFakeServer();
    renderApp(`/confirm-email#${TOKEN}`);
    expect(await screen.findByText("This link no longer works.")).toBeTruthy();
  });

  it("offers the confirmation mail on the profile of an unconfirmed account", async () => {
    const { user, server } = await openAdmin("/settings/profile", {
      user: { ...TEST_USER, emailConfirmed: false },
    });
    expect(await screen.findByText(/This address is not confirmed yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send confirmation link" }));
    expect(
      await screen.findByText("Link sent to ada@example.com. It works for 24 hours."),
    ).toBeTruthy();
    expect(server.areas.mail.confirmRequests).toBe(1);
  });

  it("says nothing about confirmation for a confirmed account", async () => {
    await openAdmin("/settings/profile", { user: { ...TEST_USER, emailConfirmed: true } });
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send confirmation link" })).toBeNull();
  });
});
