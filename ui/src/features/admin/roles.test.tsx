import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { generatedUnion } from "../../test/generated";
import { PERMISSION_GROUPS, PERMISSION_TEXT } from "./catalog";
import { openAdmin, sent } from "./test/openAdmin";

describe("permission catalog", () => {
  it("puts every permission of the server into exactly one group, with a text", () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect([...grouped].sort()).toEqual(generatedUnion("Permission").sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(Object.keys(PERMISSION_TEXT).sort()).toEqual([...grouped].sort());
  });
});

describe("roles", () => {
  it("lists built-in roles as fixed and custom roles with delete", async () => {
    await openAdmin("/admin/roles");
    const list = await screen.findByRole("list", { name: "Roles" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual([
      "Owner",
      "Admin",
      "Editor",
      "Viewer",
      "Auditor",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Built-in")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(
      within(rows[4] as HTMLElement).getByRole("button", { name: "Delete Auditor…" }),
    ).toBeTruthy();
  });

  it("shows a built-in role read-only, grouped by area with what each permission allows", async () => {
    await openAdmin("/admin/roles/editor");
    expect(await screen.findByRole("heading", { level: 1, name: "Editor" })).toBeTruthy();
    expect(screen.getByText(/Built-in roles cannot be changed/)).toBeTruthy();
    const group = screen.getByRole("group", { name: "Dashboards and folders" });
    const write = within(group).getByRole("checkbox", { name: "dashboards:write" });
    expect((write as HTMLInputElement).checked).toBe(true);
    expect((write as HTMLInputElement).disabled).toBe(true);
    expect(write.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(write.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Create and change dashboards.",
    );
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("creates a role and opens it", async () => {
    const { user, admin, location } = await openAdmin("/admin/roles");
    await screen.findByRole("list", { name: "Roles" });
    await user.click(screen.getByRole("link", { name: "New role" }));
    await screen.findByRole("heading", { level: 1, name: "New role" });
    await user.type(screen.getByLabelText("Name"), "Publisher");
    await user.type(screen.getByLabelText("Description"), "Shares dashboards");
    await user.click(screen.getByRole("checkbox", { name: "dashboards:share" }));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Publisher" })).toBeTruthy();
    const created = admin.roles.find((role) => role.name === "Publisher");
    expect(created?.permissions).toEqual(["dashboards:share"]);
    expect(location().pathname).toBe(`/admin/roles/${created?.id}`);
    expect(screen.getByText("Role “Publisher” was created.")).toBeTruthy();
  });

  it("shows a taken name at the field and the role limit as a readable text", async () => {
    const { user, server } = await openAdmin("/admin/roles/new");
    const name = await screen.findByLabelText("Name");
    await user.type(name, "Auditor");
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(
      await screen.findByText("A role with this name already exists. Choose another name."),
    ).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");

    await user.clear(name);
    await user.type(name, "Reader");
    // 409 conflict without a field: the organization has 100 custom roles.
    server.failNext("/api/orgs/o1/roles", 409, "conflict", "POST");
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(
      await screen.findByText(
        "This organization already has the most custom roles it can have. Delete one before creating another.",
      ),
    ).toBeTruthy();
  });

  it("refuses the name of a built-in role before sending, and explains the server's refusal", async () => {
    const { user, server } = await openAdmin("/admin/roles/new");
    const name = await screen.findByLabelText("Name");
    await user.type(name, "  Admin ");
    await user.click(screen.getByRole("button", { name: "Create role" }));
    const builtin =
      "The names owner, admin, editor and viewer are reserved for the built-in roles Owner, Admin, Editor and Viewer. Choose another name.";
    expect(screen.getByText(builtin)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(sent(server, "POST")).toEqual([]);

    // A name the server refuses for a reason this interface does not know yet.
    await user.clear(name);
    await user.type(name, "Reader");
    server.failNext("/api/orgs/o1/roles", 422, "validation", "POST", "name");
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(
      await screen.findByText(
        "This name belongs to a built-in role or is not allowed. Choose another name.",
      ),
    ).toBeTruthy();
  });

  it("does not rename a custom role to a built-in role's name", async () => {
    const { user, server } = await openAdmin("/admin/roles/r1");
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "VIEWER{Enter}");
    expect(
      screen.getByText(
        "The names owner, admin, editor and viewer are reserved for the built-in roles Owner, Admin, Editor and Viewer. Choose another name.",
      ),
    ).toBeTruthy();
    expect(sent(server, "PATCH")).toEqual([]);
  });

  it("keeps the description to 500 characters, over several lines", async () => {
    const { user, server } = await openAdmin("/admin/roles/new");
    await user.type(await screen.findByLabelText("Name"), "Writer");
    const description = screen.getByLabelText("Description");
    expect(description.tagName).toBe("TEXTAREA");
    await user.type(description, "first line{Enter}second line");
    expect(screen.getByText("22 of 500 characters.")).toBeTruthy();
    await user.clear(description);
    await user.click(description);
    await user.paste("x".repeat(501));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(screen.getByText("Use at most 500 characters.")).toBeTruthy();
    expect(sent(server, "POST")).toEqual([]);
  });

  it("never offers the owner-only permission for a custom role", async () => {
    await openAdmin("/admin/roles/new");
    const box = await screen.findByRole("checkbox", { name: "org:delete" });
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Only the built-in owner role has this.");
  });

  it("shows a role with permissions the user lacks read-only, without delete", async () => {
    const { user } = await openAdmin("/admin/roles", {
      permissions: ["roles:read", "roles:write", "dashboards:read"],
    });
    const list = await screen.findByRole("list", { name: "Roles" });
    // Auditor holds audit:read, which this user does not have.
    expect(within(list).queryByRole("button", { name: "Delete Auditor…" })).toBeNull();
    await user.click(within(list).getByRole("link", { name: "Auditor" }));
    expect(
      await screen.findByText(
        "This role has permissions you do not have, so you cannot change or delete it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Name")).toBeNull();
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("does not undo when someone changed the role in the meantime", async () => {
    const { user, admin } = await openAdmin("/admin/roles/r1");
    await user.click(await screen.findByRole("checkbox", { name: "teams:read" }));
    await screen.findByText("Role “Auditor” was saved.");
    const role = admin.roles.find((candidate) => candidate.id === "r1");
    if (role !== undefined) {
      role.permissions = ["audit:read", "teams:read", "users:read"];
    }
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(
        "Not undone: someone else changed this in the meantime. The page now shows the current state.",
      ),
    ).toBeTruthy();
    expect(role?.permissions).toEqual(["audit:read", "teams:read", "users:read"]);
  });

  it("saves the name once on Enter followed by leaving the field, and not on IME Enter", async () => {
    const { user, server } = await openAdmin("/admin/roles/r1");
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Reviewer");
    name.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(sent(server, "PATCH")).toEqual([]);
    await user.keyboard("{Enter}");
    await user.tab();
    await screen.findByText("Role “Reviewer” was saved.");
    expect(sent(server, "PATCH")).toEqual(["/api/orgs/o1/roles/r1"]);
  });

  it("saves a name committed while the previous save is on its way, once that save ends", async () => {
    const { user, admin, server } = await openAdmin("/admin/roles/r1");
    // Hold the first save until the second name has been committed.
    const answer = globalThis.fetch;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (holding && init?.method === "PATCH") {
        holding = false;
        const response = answer(input, init);
        await held;
        return response;
      }
      return answer(input, init);
    });
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Reviewer{Enter}");
    await waitFor(() => expect(sent(server, "PATCH")).toHaveLength(1));
    await user.clear(name);
    await user.type(name, "Inspector{Enter}");
    await user.clear(name);
    await user.type(name, "Examiner{Enter}");
    expect(sent(server, "PATCH")).toHaveLength(1);
    release();
    expect(await screen.findByText("Role “Examiner” was saved.")).toBeTruthy();
    expect(admin.roles.find((role) => role.id === "r1")?.name).toBe("Examiner");
    expect(sent(server, "PATCH")).toHaveLength(2);
  });

  it("does not let anyone add permissions they do not hold", async () => {
    const { user } = await openAdmin("/admin/roles/r1", {
      permissions: ["roles:read", "roles:write", "audit:read", "dashboards:read"],
    });
    const box = await screen.findByRole("checkbox", { name: "dashboards:write" });
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("You can only give permissions you have yourself.");
    // A held permission can be added.
    const read = screen.getByRole("checkbox", { name: "dashboards:read" });
    expect((read as HTMLInputElement).disabled).toBe(false);
    await user.click(read);
    expect(await screen.findByText("Role “Auditor” was saved.")).toBeTruthy();
  });

  it("saves each change of a custom role at once and undoes it", async () => {
    const { user, admin } = await openAdmin("/admin/roles/r1");
    const box = await screen.findByRole("checkbox", { name: "teams:read" });
    await user.click(box);
    expect(await screen.findByText("Role “Auditor” was saved.")).toBeTruthy();
    expect(admin.roles.find((role) => role.id === "r1")?.permissions).toEqual([
      "audit:read",
      "teams:read",
    ]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(admin.roles.find((role) => role.id === "r1")?.permissions).toEqual(["audit:read"]),
    );

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Reviewer{Enter}");
    await waitFor(() =>
      expect(admin.roles.find((role) => role.id === "r1")?.name).toBe("Reviewer"),
    );
  });

  it("maps a refused grant to a readable text", async () => {
    const { user, server } = await openAdmin("/admin/roles/r1");
    const box = await screen.findByRole("checkbox", { name: "teams:read" });
    server.failNext("/api/orgs/o1/roles/r1", 403, "forbidden", "PATCH");
    await user.click(box);
    expect(
      await screen.findByText("You cannot give permissions you do not have yourself."),
    ).toBeTruthy();
  });

  it("deletes a custom role after confirming", async () => {
    const { user, admin } = await openAdmin("/admin/roles");
    await screen.findByRole("list", { name: "Roles" });
    await user.click(screen.getByRole("button", { name: "Delete Auditor…" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Role “Auditor” was deleted.")).toBeTruthy();
    expect(admin.roles.map((role) => role.id)).not.toContain("r1");
  });

  it("hides creating and deleting without roles:write", async () => {
    await openAdmin("/admin/roles", { permissions: ["roles:read", "audit:read"] });
    const list = await screen.findByRole("list", { name: "Roles" });
    expect(screen.queryByRole("link", { name: "New role" })).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
  });
});
