import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "../../test/fakeServer";
import { openAdmin, sent } from "../admin/test/openAdmin";

function form() {
  return screen.findByRole("form", { name: "Mail server" });
}

const STORED = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  username: "kalzit@example.com",
  fromName: "Kalzit",
  fromAddress: "kalzit@example.com",
  replyTo: "",
};

function stored(fields: Partial<FakeServer["areas"]["mail"]["view"]> = {}) {
  return (server: FakeServer) => {
    server.areas.mail.view = {
      ...server.areas.mail.view,
      settings: STORED,
      hasPassword: true,
      source: "database",
      version: 3,
      ...fields,
    };
  };
}

describe("mail server settings", () => {
  it("says what no mail server means and opens the form", async () => {
    const { user } = await openAdmin("/settings/email", { isServerAdmin: true });
    expect(await screen.findByText("No mail server set up")).toBeTruthy();
    expect(
      screen.getByText(
        "Invitations appear as links to copy; admins reset passwords in the administration.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("What Kalzit sends by mail")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up mail server" }));
    expect(await form()).toBeTruthy();
  });

  it("saves only after a test mail with the values in the form", async () => {
    const { user, server } = await openAdmin("/settings/email", {
      isServerAdmin: true,
      setupServer: stored(),
    });
    const card = await form();
    const save = within(card).getByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);

    const port = within(card).getByRole("textbox", { name: "Port" });
    await user.clear(port);
    await user.type(port, "2525");
    expect(within(card).getByText(/Changed: Port\./)).toBeTruthy();
    expect(within(card).getByText(/Send a test mail with these values first/)).toBeTruthy();
    await user.click(save);
    expect(sent(server, "PUT")).toEqual([]);

    await user.click(within(card).getByRole("button", { name: "Send test mail" }));
    expect(await within(card).findByText("Test mail accepted.")).toBeTruthy();
    expect(
      within(card).getByText(/250 2\.0\.0 OK from the server in 640 ms · STARTTLS with TLS 1\.3/),
    ).toBeTruthy();
    const test = server.calls.find((call) => call.path === "/api/admin/mail/test")?.body as {
      settings: Record<string, unknown>;
      to: string;
      password?: string;
    };
    expect(test.settings).toMatchObject({ host: "smtp.example.com", port: 2525 });
    expect(test.to).toBe("ada@example.com");
    // An empty password field keeps the stored one: nothing is sent for it.
    expect("password" in test).toBe(false);

    await user.click(within(card).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Mail server saved.")).toBeTruthy();
    expect(server.areas.mail.view.version).toBe(4);
    expect(server.areas.mail.view.settings?.port).toBe(2525);
  });

  it("marks the field a failed test mail names", async () => {
    const { user } = await openAdmin("/settings/email", {
      isServerAdmin: true,
      setupServer: (server) => {
        stored()(server);
        server.areas.mail.testAnswer = {
          status: 422,
          code: "validation",
          field: "password",
          reason: "mail.auth_rejected",
          params: { reply: "535 5.7.8 Authentication failed" },
        };
      },
    });
    const card = await form();
    await user.click(within(card).getByRole("button", { name: "Send test mail" }));
    const password = within(card).getByLabelText("Password");
    await waitFor(() => expect(password.getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(card).getByText(
        "The mail server refused the sign-in. Check user and password. (535 5.7.8 Authentication failed)",
      ),
    ).toBeTruthy();
    expect(within(card).getByText(/^Check the marked field\./)).toBeTruthy();
  });

  it("shows settings from the file read-only, with their source", async () => {
    await openAdmin("/settings/email", {
      isServerAdmin: true,
      setupServer: stored({ source: "file", editable: false, hasPassword: false }),
    });
    const card = await form();
    expect(within(card).getByText("from kalzit.toml")).toBeTruthy();
    const server = within(card).getByRole("textbox", { name: "Server" }) as HTMLInputElement;
    expect(server.disabled).toBe(true);
    // The section's notice says why, and every control points to it.
    const notice = within(card).getByText(/^These values come from kalzit\.toml/);
    expect(server.getAttribute("aria-describedby")?.split(" ")).toContain(notice.id);
    const port = within(card).getByRole("textbox", { name: "Port" }) as HTMLInputElement;
    expect(port.disabled).toBe(true);
    expect(port.getAttribute("aria-describedby")).toBe(notice.id);
    for (const option of within(card).getAllByRole("radio")) {
      expect((option as HTMLButtonElement).disabled).toBe(true);
    }
    expect(within(card).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Send test mail" })).toBeTruthy();
  });

  it("warns when links have no public address", async () => {
    await openAdmin("/settings/email", {
      isServerAdmin: true,
      setupServer: stored({ publicUrl: null }),
    });
    expect(
      await screen.findByText(
        "Without a public address (server.public_url) Kalzit sends no links: no invitations and no password links.",
      ),
    ).toBeTruthy();
  });
});
