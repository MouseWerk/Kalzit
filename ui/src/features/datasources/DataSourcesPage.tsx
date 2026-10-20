import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function DataSourcesPage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.title");
  return (
    <Page title={t("datasources.title")} lead={t("datasources.lead")}>
      <EmptyState icon="dataSources" title={t("datasources.empty.title")}>
        {t("datasources.empty.text")}
      </EmptyState>
    </Page>
  );
}
