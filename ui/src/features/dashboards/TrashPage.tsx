import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { DASHBOARDS_KEY, fetchDashboards, restoreDashboard } from "./api";
import "./dashboards.css";
import { errorMessage } from "./ui/errors";

export function TrashPage() {
  const { t } = useI18n();
  useDocumentTitle("dashboards.trash.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  let body = null;
  if (org !== undefined && permissions.has("dashboards:delete")) {
    body = <TrashList orgId={org.id} />;
  } else if (permissions.loaded) {
    body = (
      <EmptyState icon="lock" title={t("dashboards.forbidden.title")}>
        {t("dashboards.trash.forbidden")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("dashboards.trash.title")} lead={t("dashboards.trash.lead")}>
      {body}
    </Page>
  );
}

function TrashList({ orgId }: { orgId: string }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const trash = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "trash"],
    queryFn: () => fetchDashboards(orgId, { deleted: true }),
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreDashboard(orgId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] }),
  });
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });

  if (trash.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (trash.isError) {
    return <FormAlert>{errorMessage(t, trash.error)}</FormAlert>;
  }
  const back = (
    <Link to="/dashboards" className="versions__back">
      {t("dashboards.backToList")}
    </Link>
  );
  if (trash.data.items.length === 0) {
    return (
      <>
        {back}
        <EmptyState icon="dashboards" title={t("dashboards.trash.empty")}>
          {t("dashboards.trash.emptyText")}
        </EmptyState>
      </>
    );
  }
  return (
    <div className="versions">
      {back}
      <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("dashboards.column.title")}</th>
            <th scope="col">{t("dashboards.trash.deletedAt")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("dashboards.history.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {trash.data.items.map((item) => (
            <tr key={item.id}>
              <td>{item.title === "" ? t("dashboards.untitled") : item.title}</td>
              <td>{item.deletedAt === undefined ? "" : format.format(item.deletedAt)}</td>
              <td className="data-table__actions">
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => restore.mutate(item.id)}
                  disabled={restore.isPending}
                  aria-label={t("dashboards.trash.restoreNamed", { title: item.title })}
                >
                  {t("dashboards.trash.restore")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
