import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { openAdmin, sent } from "../admin/test/openAdmin";
import { base64UrlForTests } from "./webauthn";

async function enterPassword(path: string) {
  const view = renderApp(path);
  const { user } = view;
  await user.click(await screen.findByLabelText("Email address"));
  await user.paste(TEST_USER.email);
  await user.click(screen.getByLabelText("Password"));
  await user.paste(TEST_PASSWORD);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return view;
}

describe("second step of the sign-in", () => {
  it("asks for the app’s code, says when it is wrong and signs in with the right one", async () => {
    const server = installFakeServer();
    server.security.totp = true;
    server.security.recoveryCodes = ["k7q2-m9xd-p4tz-8wna"];
    const { user, location } = await enterPassword("/login");
    expect(await screen.findByRole("heading", { name: "Confirm it’s you" })).toBeTruthy();
    expect(server.state.signedIn).toBe(false);
    expect(screen.getByText(TEST_USER.email)).toBeTruthy();

    const code = screen.getByLabelText("Six-digit code");
    // The sixth digit sends the code on its own.
    await user.type(code, "111 111");
    expect(await screen.findByText("The code is not correct.")).toBeTruthy();
    expect(server.state.signedIn).toBe(false);

    await user.clear(code);
    await user.type(code, server.security.code);
    await waitFor(() => expect(location().pathname).toBe("/"));
    expect(server.state.signedIn).toBe(true);
  });

  it("locks after five wrong codes and counts down", async () => {
    const server = installFakeServer();
    server.security.totp = true;
    const { user } = await enterPassword("/login");
    const code = await screen.findByLabelText("Six-digit code");
    for (let i = 0; i < 5; i += 1) {
      await user.clear(code);
      await user.type(code, "000000");
    }
    expect(await screen.findByText(/Too many wrong codes\. Locked until/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Possible again in/ }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("signs in with a recovery code and says how many are left", async () => {
    const server = installFakeServer();
    server.security.totp = true;
    server.security.recoveryCodes = ["k7q2-m9xd-p4tz-8wna", "c3hv-r2ke-x9bm-5fgu"];
    const { user, location } = await enterPassword("/login");
    await user.click(await screen.findByRole("button", { name: "Use a recovery code" }));
    await user.type(screen.getByLabelText("Recovery code"), "K7Q2-M9XD-P4TZ-8WNA");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Signed in with a recovery code.")).toBeTruthy();
    expect(screen.getByText(/You have 1 codes left/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(location().pathname).toBe("/"));
  });

  it("goes back to the password with Sign out", async () => {
    const server = installFakeServer();
    server.security.totp = true;
    const { user } = await enterPassword("/login");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByLabelText("Password")).toBeTruthy();
    expect(server.security.pending).toBe(true);
  });
});

describe("forced setup", () => {
  it("sets up the app in three steps and opens the app only after the codes are put away", async () => {
    const server = installFakeServer();
    server.security.required = { kind: "org", id: "o1", name: "Analytical Engines" };
    server.security.allowed = { passkey: false, totp: true };
    const { user, location } = await enterPassword("/login");
    expect(await screen.findByRole("heading", { name: "Set up a second factor" })).toBeTruthy();
    expect(screen.getByText(/Analytical Engines requires a second factor/)).toBeTruthy();
    const app = screen.getByRole("radio", { name: /Authenticator app/ });
    expect(app.getAttribute("aria-checked")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Connect an authenticator app" }),
    ).toBeTruthy();
    expect(screen.getByRole("img", { name: "QR code of the key" })).toBeTruthy();
    await user.type(screen.getByLabelText("Six-digit code"), server.security.code);

    expect(await screen.findByRole("heading", { name: "Your recovery codes" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Recovery codes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    const done = screen.getByRole("button", { name: "Done" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    await user.click(done);
    expect(location().pathname).toBe("/login");
    await user.click(screen.getByRole("checkbox", { name: "I have stored the codes safely" }));
    await user.click(done);
    await waitFor(() => expect(location().pathname).toBe("/"));
  });
});

describe("account: sign-in and security", () => {
  it("sets up the app and shows the first recovery codes once", async () => {
    const server = installFakeServer({ signedIn: true });
    const { user } = renderApp("/settings/account-security");
    expect(await screen.findByText(/Protect your account with a second factor/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up" }));
    const dialog = await screen.findByRole("dialog", { name: "Set up an authenticator app" });
    await user.type(within(dialog).getByLabelText("Six-digit code"), "999999");
    expect(
      await within(dialog).findByText(
        "The code does not match the key. Wait for the next code and check the time of your phone.",
      ),
    ).toBeTruthy();
    const code = within(dialog).getByLabelText("Six-digit code");
    await user.clear(code);
    await user.type(code, server.security.code);
    const codes = await screen.findByRole("dialog", { name: "Your recovery codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(server.security.totp).toBe(true);
  });

  it("refuses to remove the last method while one is required", async () => {
    const server = installFakeServer({ signedIn: true });
    server.security.totp = true;
    server.security.required = { kind: "server" };
    const { user } = renderApp("/settings/account-security");
    expect(await screen.findByText("A second factor is required for your account.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("dialog", { name: "Remove the last method?" })).toBeTruthy();
    expect(server.security.totp).toBe(true);
  });

  it("asks for a fresh confirmation before making new recovery codes", async () => {
    const server = installFakeServer({ signedIn: true });
    server.security.totp = true;
    server.security.recoveryCodes = ["k7q2-m9xd-p4tz-8wna"];
    const { user } = renderApp("/settings/account-security");
    await user.click(await screen.findByRole("button", { name: "Make new ones" }));
    const dialog = await screen.findByRole("dialog", { name: "Make new recovery codes?" });
    expect(within(dialog).getByText("Confirm with your second factor first.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Six-digit code"), server.security.code);
    const codes = await screen.findByRole("dialog", { name: "Your recovery codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
  });
});

describe("the second factor’s rule", () => {
  it("asks for a fresh confirmation before the change goes through", async () => {
    const path = "/api/admin/settings/security.two_factor_required";
    const { user, server } = await openAdmin("/settings/signin", {
      isServerAdmin: true,
      setup: (admin) => {
        admin.serverSettings.push({
          key: "security.two_factor_required",
          scope: "server",
          value: "off",
          default: "off",
          source: "default",
          editable: true,
          version: 0,
          description: "Who must sign in with a second factor",
          updatedAt: null,
          updatedBy: null,
        });
      },
      setupServer: (fake) => {
        fake.security.totp = true;
        fake.failNext(path, 403, "confirmation_required", "PATCH");
      },
    });
    await user.click(await screen.findByRole("radio", { name: "For everyone" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm with your second factor" });
    await user.type(within(dialog).getByLabelText("Six-digit code"), server.security.code);
    await waitFor(() => expect(sent(server, "PATCH").filter((p) => p === path)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("passkey options", () => {
  it("converts base64url both ways", () => {
    const { fromBase64Url, toBase64Url } = base64UrlForTests;
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
    const text = toBase64Url(bytes.buffer);
    expect(text).toBe("APr7_P3-_w");
    expect(new Uint8Array(fromBase64Url(text ?? ""))).toEqual(bytes);
  });
});
