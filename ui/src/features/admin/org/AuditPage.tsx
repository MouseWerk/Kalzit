import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listMembers, MAX_PAGE_SIZE } from "../api";
import { AuditLog } from "../components/AuditLog";
import { Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";

export function AuditPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const canRead = access.has("audit:read");
  // The actor filter offers the members, when the user may see them.
  const members = useQuery({
    queryKey: [...adminKeys.members(orgId), "picker"],
    queryFn: () => listMembers(orgId, undefined, MAX_PAGE_SIZE),
    enabled: canRead && access.has("users:read"),
  });
  return (
    <Section
      title="admin.audit.title"
      lead="admin.audit.lead"
      allowed={allowedWhen(access, canRead)}
    >
      {canRead ? (
        <AuditLog
          orgId={orgId}
          actors={members.data?.items.map((member) => ({
            id: member.userId,
            label: t("admin.common.nameAndEmail", { name: member.name, email: member.email }),
          }))}
        />
      ) : null}
    </Section>
  );
}
