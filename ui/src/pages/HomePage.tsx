import { getRouteApi } from "@tanstack/react-router";
import { EmptyState } from "../components/EmptyState";
import { Page } from "../components/Page";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";

const appRoute = getRouteApi("/_app");

export function HomePage() {
  const { t } = useI18n();
  useDocumentTitle("home.title");
  const { me } = appRoute.useRouteContext();
  return (
    <Page title={t("home.welcome", { name: me.name })} lead={t("home.lead")}>
      {/* No call to action yet: every page it could lead to is still a placeholder. */}
      <EmptyState icon="dashboards" title={t("home.empty.title")}>
        {t("home.empty.text")}
      </EmptyState>
    </Page>
  );
}
