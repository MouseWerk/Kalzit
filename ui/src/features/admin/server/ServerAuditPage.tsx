import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listUsers, MAX_PAGE_SIZE } from "../api";
import { AuditLog } from "../components/AuditLog";
import { Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";

/** Everything recorded on the server, across organizations. */
export function ServerAuditPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const users = useQuery({
    queryKey: [...adminKeys.users, "picker"],
    queryFn: () => listUsers(undefined, MAX_PAGE_SIZE),
    enabled: access.isServerAdmin,
  });
  return (
    <Section
      title="admin.serverAudit.title"
      lead="admin.serverAudit.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
    >
      {access.isServerAdmin ? (
        <AuditLog
          orgId={null}
          actors={users.data?.items.map((user) => ({
            id: user.id,
            label: t("admin.common.nameAndEmail", { name: user.name, email: user.email }),
          }))}
        />
      ) : null}
    </Section>
  );
}
