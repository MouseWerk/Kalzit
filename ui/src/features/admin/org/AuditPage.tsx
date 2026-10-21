import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listMembers, MAX_PAGE_SIZE } from "../api";
import { AuditLog } from "../components/AuditLog";
import { usePagedList } from "../components/lists";
import { Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";

export function AuditPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const canRead = access.has("audit:read");
  // The person filter offers the members, when the user may see them.
  const canPick = canRead && access.has("users:read");
  const members = usePagedList(
    [...adminKeys.members(orgId), "picker"],
    (cursor) => listMembers(orgId, cursor, MAX_PAGE_SIZE),
    canPick,
  );
  return (
    <Section
      title="admin.audit.title"
      lead="admin.audit.lead"
      allowed={allowedWhen(access, canRead)}
    >
      {canRead ? (
        <AuditLog
          orgId={orgId}
          actors={
            canPick
              ? members.picker((member) => ({
                  id: member.userId,
                  label: t("admin.common.nameAndEmail", { name: member.name, email: member.email }),
                }))
              : undefined
          }
        />
      ) : null}
    </Section>
  );
}
