import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listOrgs, listUsers, MAX_PAGE_SIZE } from "../api";
import { AuditLog } from "../components/AuditLog";
import { usePagedList } from "../components/lists";
import { Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";

/** Everything recorded on the server, across organizations, sign-ins included. */
export function ServerAuditPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const users = usePagedList(
    [...adminKeys.users, "picker"],
    (cursor) => listUsers(cursor, MAX_PAGE_SIZE),
    access.isServerAdmin,
  );
  const orgs = usePagedList(
    [...adminKeys.orgs, "picker"],
    (cursor) => listOrgs(cursor, MAX_PAGE_SIZE),
    access.isServerAdmin,
  );
  return (
    <Section
      title="admin.serverAudit.title"
      lead="admin.serverAudit.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
    >
      {access.isServerAdmin ? (
        <AuditLog
          orgId={null}
          actors={users.picker((user) => ({
            id: user.id,
            label: t("admin.common.nameAndEmail", { name: user.name, email: user.email }),
          }))}
          orgs={orgs.picker((org) => ({ id: org.id, label: org.name }))}
        />
      ) : null}
    </Section>
  );
}
