import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useOrgPermissions } from "../../org/useOrg";
import { canOpenAdministration } from "./access";

export function AdminPage() {
  const { t } = useI18n();
  useDocumentTitle("admin.title");
  const permissions = useOrgPermissions();
  let body = null;
  if (canOpenAdministration(permissions)) {
    body = (
      <EmptyState icon="admin" title={t("admin.empty.title")}>
        {t("admin.empty.text")}
      </EmptyState>
    );
  } else if (permissions.loaded) {
    // Only once the permissions are known, so a permitted user never sees "No access" flash.
    body = (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("admin.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("admin.title")} lead={t("admin.lead")}>
      {body}
    </Page>
  );
}
