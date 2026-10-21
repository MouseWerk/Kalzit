import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { errorMessage } from "../dashboards/ui/errors";
import { DATASOURCES_KEY, datasourcesQuery, kindsQuery, restoreDatasource } from "./api";
import "./datasources.css";
import { canSeeDatasources } from "./nav";

const listRoute = getRouteApi("/_app/data-sources");

export function DataSourcesPage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  let body = null;
  if (org === undefined) {
    body = (
      <EmptyState icon="dataSources" title={t("datasources.noOrg.title")}>
        {t("datasources.noOrg.text")}
      </EmptyState>
    );
  } else if (canSeeDatasources(permissions)) {
    body = <DataSourceList orgId={org.id} canWrite={permissions.has("datasources:write")} />;
  } else if (permissions.loaded) {
    body = (
      <EmptyState icon="lock" title={t("datasources.forbidden.title")}>
        {t("datasources.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("datasources.title")} lead={t("datasources.lead")}>
      {body}
    </Page>
  );
}

function DataSourceList({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const navigate = listRoute.useNavigate();
  const { deleted } = listRoute.useSearch();
  const list = useQuery(datasourcesQuery(orgId));
  const kinds = useQuery(kindsQuery(orgId));
  const restore = useMutation({
    mutationFn: (id: string) => restoreDatasource(orgId, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
      await navigate({ search: {}, replace: true });
    },
  });
  const kindName = (kind: string) => kinds.data?.find((k) => k.kind === kind)?.name ?? kind;
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium" });

  const addButton = canWrite ? (
    <Link to="/data-sources/new" search={{}} className="button button--primary">
      {t("datasources.add")}
    </Link>
  ) : null;

  const trashNotice =
    deleted === undefined ? null : (
      <div className="notice ds-trash-notice" role="status">
        <Icon name="check" />
        <span>{t("datasources.deleted")}</span>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => restore.mutate(deleted)}
          disabled={restore.isPending}
        >
          {t("datasources.restore")}
        </button>
      </div>
    );

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  if (list.data.length === 0) {
    return (
      <>
        {trashNotice}
        <EmptyState icon="dataSources" title={t("datasources.empty.title")} actions={addButton}>
          {canWrite ? t("datasources.empty.text") : t("datasources.empty.textReadOnly")}
        </EmptyState>
      </>
    );
  }
  return (
    <div className="ds-list">
      {trashNotice}
      <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
      {addButton === null ? null : <div className="toolbar">{addButton}</div>}
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("datasources.column.name")}</th>
            <th scope="col">{t("datasources.column.kind")}</th>
            <th scope="col">{t("datasources.column.created")}</th>
          </tr>
        </thead>
        <tbody>
          {list.data.map((source) => (
            <tr key={source.id}>
              <td>
                {canWrite ? (
                  <Link to="/data-sources/$datasourceId" params={{ datasourceId: source.id }}>
                    {source.name}
                  </Link>
                ) : (
                  source.name
                )}
              </td>
              <td>{kindName(source.kind)}</td>
              <td>{dateFormat.format(source.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
