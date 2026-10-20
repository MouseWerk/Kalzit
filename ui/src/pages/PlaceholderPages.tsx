import { getRouteApi } from "@tanstack/react-router";
import { canAdminister } from "../api/auth";
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

export function DataSourcesPage() {
  const { t } = useI18n();
  useDocumentTitle("dataSources.title");
  return (
    <Page title={t("dataSources.title")} lead={t("dataSources.lead")}>
      <EmptyState icon="dataSources" title={t("dataSources.empty.title")}>
        {t("dataSources.empty.text")}
      </EmptyState>
    </Page>
  );
}

export function AdminPage() {
  const { t } = useI18n();
  useDocumentTitle("admin.title");
  const { me } = appRoute.useRouteContext();
  return (
    <Page title={t("admin.title")} lead={t("admin.lead")}>
      {canAdminister(me) ? (
        <EmptyState icon="admin" title={t("admin.empty.title")}>
          {t("admin.empty.text")}
        </EmptyState>
      ) : (
        <EmptyState icon="lock" title={t("admin.forbidden.title")}>
          {t("admin.forbidden.text")}
        </EmptyState>
      )}
    </Page>
  );
}
