import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function DashboardsPage() {
  const { t } = useI18n();
  useDocumentTitle("dashboards.title");
  return (
    <Page title={t("dashboards.title")} lead={t("dashboards.lead")}>
      <EmptyState icon="dashboards" title={t("dashboards.empty.title")}>
        {t("dashboards.empty.text")}
      </EmptyState>
    </Page>
  );
}
