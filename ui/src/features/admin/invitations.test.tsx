import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MAIL_AT } from "../../test/fakeMail";
import type { FakeServer } from "../../test/fakeServer";
import type { Invitation } from "./invitationsApi";
import { ALL_PERMISSIONS, openAdmin, sent } from "./test/openAdmin";

function invitation(fields: Partial<Invitation> = {}): Invitation {
  return {
    id: "i1",
    email: "nora@example.com",
    role: "editor",
    teamId: "t1",
    teamName: "Analysts",
    invitedByName: "Ada Lovelace",
    createdAt: MAIL_AT,
    expiresAt: MAIL_AT + 7 * 86_400_000,
    state: "pending",
    delivery: "sent",
    deliveryDetail: null,
    deliveredAt: MAIL_AT,
    ...fields,
  };
}

function seed(...items: Invitation[]) {
  return (server: FakeServer) => {
    server.areas.mail.invitations = items;
  };
}

describe("invitations", () => {
  it("invites by mail after checking every address, and lists the open invitations", async () => {
    const { user, server } = await openAdmin("/admin/members");
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    await user.type(
      within(dialog).getByLabelText("Email addresses"),
      "nora@example.com, ole@muellersoehne",
    );
    await user.click(within(dialog).getByRole("button", { name: "Send 2 invitations" }));
    expect(within(dialog).getByText("“ole@muellersoehne” is not a complete address.")).toBeTruthy();
    expect(sent(server, "POST")).not.toContain("/api/orgs/o1/invitations");

    await user.type(within(dialog).getByLabelText("Email addresses"), ".example");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "editor");
    await user.selectOptions(within(dialog).getByLabelText("Team"), "t1");
    await user.click(within(dialog).getByRole("button", { name: "Send 2 invitations" }));
    expect(await screen.findByText("Invitations sent: 2.")).toBeTruthy();
    expect(
      server.calls.find(
        (call) => call.method === "POST" && call.path === "/api/orgs/o1/invitations",
      )?.body,
    ).toEqual({
      emails: ["nora@example.com", "ole@muellersoehne.example"],
      role: "editor",
      teamId: "t1",
    });
    const list = await screen.findByRole("list", { name: "Open invitations" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByText("Delivered")).toHaveLength(2);
  });

  it("hands out the links to pass on without a mail server", async () => {
    const { user } = await openAdmin("/admin/members", {
      setupServer: (server) => {
        server.areas.mail.mailed = false;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    await user.type(within(dialog).getByLabelText("Email addresses"), "nora@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Send invitation" }));
    const created = await screen.findByRole("dialog", { name: "Invitation created" });
    const link = within(created).getByLabelText("Link for nora@example.com") as HTMLInputElement;
    expect(link.value).toMatch(/^https:\/\/kalzit\.example\.com\/invite#/);
    expect(within(created).getByText(/No mail server is set up\./)).toBeTruthy();
    await user.click(within(created).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const list = await screen.findByRole("list", { name: "Open invitations" });
    expect(within(list).getByText("Link to pass on")).toBeTruthy();
  });

  it("names the address the server refused", async () => {
    const { user } = await openAdmin("/admin/members", {
      setupServer: (server) => {
        server.areas.mail.inviteAnswer = {
          status: 409,
          code: "conflict",
          field: "emails",
          reason: "mail.invite_already_member",
          params: { email: "grace@example.com" },
        };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = screen.getByRole("dialog", { name: "Invite people" });
    await user.type(within(dialog).getByLabelText("Email addresses"), "grace@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Send invitation" }));
    expect(
      await within(dialog).findByText("“grace@example.com” is a member already."),
    ).toBeTruthy();
  });

  it("shows a refused mail with the server's answer", async () => {
    await openAdmin("/admin/members", {
      setupServer: seed(
        invitation({ delivery: "failed", deliveryDetail: "550 5.1.1 mailbox unknown" }),
      ),
    });
    const list = await screen.findByRole("list", { name: "Open invitations" });
    expect(within(list).getByText("Refused")).toBeTruthy();
    expect(within(list).getByText("550 5.1.1 mailbox unknown")).toBeTruthy();
    expect(within(list).getByText("Editor · Analysts · invited by Ada Lovelace")).toBeTruthy();
  });

  it("sends again, revokes after asking, and invites expired ones again", async () => {
    const { user, server } = await openAdmin("/admin/members", {
      setupServer: seed(
        invitation(),
        invitation({ id: "i2", email: "finn@example.com", state: "expired" }),
      ),
    });
    const list = await screen.findByRole("list", { name: "Open invitations" });
    await user.click(within(list).getByRole("button", { name: "Send again to nora@example.com" }));
    expect(
      await screen.findByText("New link sent to nora@example.com; the old one no longer works."),
    ).toBeTruthy();

    expect(within(list).getByText("expired")).toBeTruthy();
    await user.click(within(list).getByRole("button", { name: "Invite again: finn@example.com" }));
    await waitFor(() =>
      expect(server.areas.mail.invitations.find((i) => i.id === "i2")?.state).toBe("pending"),
    );

    await user.click(
      within(list).getByRole("button", { name: "Revoke the invitation to nora@example.com" }),
    );
    const confirm = screen.getByRole("dialog", { name: "Revoke invitation" });
    expect(
      within(confirm).getByText("The link to nora@example.com no longer works afterwards."),
    ).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Invitation to nora@example.com revoked.")).toBeTruthy();
    expect(server.areas.mail.invitations.map((i) => i.id)).toEqual(["i2"]);
  });

  it("copies a pending invitation's link again", async () => {
    const { user } = await openAdmin("/admin/members", { setupServer: seed(invitation()) });
    const list = await screen.findByRole("list", { name: "Open invitations" });
    await user.click(within(list).getByRole("button", { name: "Copy link for nora@example.com" }));
    expect(await screen.findByText("Link copied.")).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe("https://kalzit.example.com/invite#token-i1");
  });

  it("is hidden without users:invite", async () => {
    await openAdmin("/admin/members", {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== "users:invite"),
      setupServer: seed(invitation()),
    });
    await screen.findByRole("list", { name: "Members" });
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Open invitations" })).toBeNull();
  });

  it("sends a member the password link from the row menu", async () => {
    const { user, server } = await openAdmin("/admin/members");
    const list = await screen.findByRole("list", { name: "Members" });
    await user.click(within(list).getByRole("button", { name: "More for Grace Hopper" }));
    await user.click(await screen.findByRole("menuitem", { name: "Send password link" }));
    expect(await screen.findByText("Password link sent to grace@example.com.")).toBeTruthy();
    expect(server.areas.mail.passwordLinks).toEqual(["u2"]);
  });

  it("says when the server sends no mail for a password link", async () => {
    const { user } = await openAdmin("/admin/members", {
      setupServer: (server) => {
        server.areas.mail.passwordLinkAnswer = {
          status: 409,
          code: "conflict",
          reason: "mail.reset_unavailable",
        };
      },
    });
    const list = await screen.findByRole("list", { name: "Members" });
    await user.click(within(list).getByRole("button", { name: "More for Grace Hopper" }));
    await user.click(await screen.findByRole("menuitem", { name: "Send password link" }));
    expect(
      await screen.findByText(
        "This server does not send mail. A server admin can set a new password under Users.",
      ),
    ).toBeTruthy();
  });
});
