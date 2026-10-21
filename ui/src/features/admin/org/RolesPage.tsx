import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, deleteRole, MAX_CUSTOM_ROLES, type Role } from "../api";
import { holdsAll, roleLabel } from "../catalog";
import { ConfirmDialog } from "../components/Dialog";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { useRoles } from "./shared";

/** Built-in roles (read only) and the organization's own roles. */
export function RolesPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("roles:read");
  const canWrite = access.has("roles:write");
  const roles = useRoles(access.orgId, canRead);
  const notice = useNotice();
  const [deleting, setDeleting] = useState<Role | null>(null);
  const list = roles.data ?? [];
  const atLimit = list.filter((role) => !role.builtin).length >= MAX_CUSTOM_ROLES;
  const keys = useRowKeys(list.length);

  const remove = useMutation({
    mutationFn: (role: Role) => deleteRole(orgId, role.id),
    onSuccess: async (_, role) => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });
      notice.show({ message: t("admin.roles.deleted", { name: role.name }) });
    },
  });

  return (
    <Section
      title="admin.roles.title"
      lead="admin.roles.lead"
      allowed={allowedWhen(access, canRead)}
      actions={
        !canWrite ? undefined : atLimit ? (
          <p className="admin-section__lead">
            {t("admin.roles.limitReached", { count: MAX_CUSTOM_ROLES })}
          </p>
        ) : (
          <Link
            to="/admin/roles/$roleId"
            params={{ roleId: "new" }}
            className="button button--primary"
          >
            {t("admin.roles.create")}
          </Link>
        )
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {roles.data === undefined ? (
        <LoadState error={roles.error} onRetry={() => void roles.refetch()} />
      ) : (
        <ul className="admin-list" aria-label={t("admin.roles.title")} {...keys.listProps}>
          {list.map((role, index) => (
            <li key={role.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <Link
                  to="/admin/roles/$roleId"
                  params={{ roleId: role.id }}
                  className="admin-row__title"
                >
                  {roleLabel(t, role.id, list)}
                </Link>
                <span className="admin-row__meta">
                  {role.builtin ? t("admin.roles.builtinText") : role.description}
                </span>
              </div>
              <span className="admin-row__meta">
                {t(
                  role.permissions.length === 1
                    ? "admin.roles.permissionOne"
                    : "admin.roles.permissionMany",
                  {
                    count: role.permissions.length,
                  },
                )}
              </span>
              <div className="admin-row__actions">
                {role.builtin ? (
                  <span className="admin-badge">{t("admin.roles.builtin")}</span>
                ) : canWrite && holdsAll(access.has, role.permissions) ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={t("admin.roles.deleteNamed", { name: role.name })}
                    onClick={() => {
                      remove.reset();
                      setDeleting(role);
                    }}
                  >
                    {t("admin.common.deleteAsk")}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("admin.roles.deleteTitle")}
        confirmLabel={t("admin.common.delete")}
        busy={remove.isPending}
        error={
          remove.error === null
            ? null
            : errorText(t, remove.error, { conflict: "admin.roles.inUse" })
        }
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
      >
        {t("admin.roles.deleteText", { name: deleting?.name ?? "" })}
      </ConfirmDialog>
    </Section>
  );
}
