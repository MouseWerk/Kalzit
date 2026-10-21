import { unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

test("the owner creates accounts, adds them as members with roles and builds a team", async ({
  page,
}) => {
  await signInOwner(page);
  const editor = { name: unique("Erik Editor"), password: "editor-password-e2e" };
  const viewer = { name: unique("Vera Viewer"), password: "viewer-password-e2e" };
  const mail = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@kalzit.test`;

  // Accounts: server administration, Users.
  await page.goto("/admin/server/users");
  for (const person of [editor, viewer]) {
    await page.getByRole("button", { name: t("admin.users.create") }).click();
    const dialog = page.getByRole("dialog", { name: t("admin.users.createTitle") });
    await dialog.getByLabel(t("admin.users.name")).fill(person.name);
    await dialog.getByLabel(t("admin.users.email")).fill(mail(person.name));
    await dialog.getByLabel(t("admin.users.password"), { exact: true }).fill(person.password);
    await dialog.getByRole("button", { name: t("admin.users.createSubmit") }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status")).toContainText(
      t("admin.users.created", { name: person.name }),
    );
  }

  // Members: each account joins the organization with its role.
  await page.goto("/admin/members");
  for (const [person, role] of [
    [editor, "admin.role.editor"],
    [viewer, "admin.role.viewer"],
  ] as const) {
    await page.getByRole("button", { name: t("admin.members.add") }).click();
    const dialog = page.getByRole("dialog", { name: t("admin.members.addTitle") });
    await dialog.getByLabel(t("admin.members.email")).fill(mail(person.name));
    await dialog.getByLabel(t("admin.members.role")).selectOption({ label: t(role) });
    await dialog.getByRole("button", { name: t("admin.members.addSubmit") }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel(t("admin.members.roleOf", { name: person.name }))).toHaveValue(
      role.replace("admin.role.", ""),
    );
  }

  // Changing a role applies at once and can be undone.
  const viewerRole = page.getByLabel(t("admin.members.roleOf", { name: viewer.name }));
  await viewerRole.selectOption({ label: t("admin.role.editor") });
  await expect(page.getByRole("status")).toContainText(
    t("admin.members.roleChanged", { name: viewer.name, role: t("admin.role.editor") }),
  );
  await page.getByRole("button", { name: t("admin.common.undo") }).click();
  await expect(viewerRole).toHaveValue("viewer");

  // A team with the editor in it.
  const team = unique("Vertrieb");
  await page.goto("/admin/teams");
  await page.getByRole("button", { name: t("admin.teams.create") }).click();
  const create = page.getByRole("dialog", { name: t("admin.teams.createTitle") });
  await create.getByLabel(t("admin.teams.name")).fill(team);
  await create.getByRole("button", { name: t("admin.teams.createSubmit") }).click();
  await expect(page.getByRole("status")).toContainText(t("admin.teams.created", { name: team }));

  await page.getByRole("link", { name: team }).click();
  await page.getByRole("button", { name: t("admin.teams.addMember") }).click();
  const add = page.getByRole("dialog", { name: t("admin.teams.addMemberTitle") });
  await add
    .getByLabel(t("admin.teams.member"))
    .selectOption({
      label: t("admin.common.nameAndEmail", { name: editor.name, email: mail(editor.name) }),
    });
  await add.getByRole("button", { name: t("admin.teams.addMemberSubmit") }).click();
  await expect(page.getByRole("list", { name: t("admin.teams.members") })).toContainText(
    editor.name,
  );

  await page.goto("/admin/teams");
  await expect(page.getByRole("listitem").filter({ hasText: team })).toContainText(
    t("admin.teams.memberOne", { count: 1 }),
  );
});
