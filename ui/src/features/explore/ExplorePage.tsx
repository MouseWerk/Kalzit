import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export function ExplorePage() {
  const { t } = useI18n();
  useDocumentTitle("explore.title");
  return (
    <Page title={t("explore.title")} lead={t("explore.lead")}>
      <EmptyState icon="explore" title={t("explore.empty.title")}>
        {t("explore.empty.text")}
      </EmptyState>
    </Page>
  );
}
