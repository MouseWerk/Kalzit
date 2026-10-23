import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { errorMessage } from "../dashboards/ui/errors";
import {
  checkHealth,
  DATASOURCES_KEY,
  type DatasourceSummary,
  fetchDatasourcePage,
  type Health,
  kindsQuery,
  restoreDatasource,
  sourceAccess,
} from "./api";
import { HealthResult } from "./DataSourceForm";
import { KindLabel } from "./kindMarks";
import "./datasources.css";

const listRoute = getRouteApi("/_app/data-sources");

export function DataSourcesPage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const { trash } = listRoute.useSearch();
  let body = null;
  if (org === undefined) {
    body = (
      <EmptyState icon="dataSources" title={t("datasources.noOrg.title")}>
        {t("datasources.noOrg.text")}
      </EmptyState>
    );
  } else {
    // Every member may ask: the list holds the sources the caller may read or query, and the
    // trash those they may restore, through the role or a grant on the source.
    body = (
      <DataSourceList
        key={trash === true ? "trash" : "list"}
        orgId={org.id}
        trash={trash === true}
        canCreate={permissions.has("datasources:write")}
      />
    );
  }
  return (
    <Page
      title={trash === true ? t("datasources.trash.title") : t("datasources.title")}
      lead={trash === true ? t("datasources.trash.lead") : t("datasources.lead")}
    >
      {body}
    </Page>
  );
}

function DataSourceList({
  orgId,
  trash,
  canCreate,
}: {
  orgId: string;
  trash: boolean;
  /** Adding a source needs the org-wide `datasources:write`; a grant is always on one source. */
  canCreate: boolean;
}) {
  const { t, language } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = listRoute.useNavigate();
  const { deleted } = listRoute.useSearch();
  const list = useInfiniteQuery({
    queryKey: [DATASOURCES_KEY, orgId, trash ? "trash" : "list"],
    queryFn: ({ pageParam, signal }) =>
      fetchDatasourcePage(orgId, { cursor: pageParam, trash }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const kinds = useQuery(kindsQuery(orgId));
  const restore = useMutation({
    mutationFn: (id: string) => restoreDatasource(orgId, id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
      if (deleted !== undefined) {
        await navigate({ search: (prev) => ({ ...prev, deleted: undefined }), replace: true });
      }
    },
  });
  const kindName = (kind: string) => kinds.data?.find((k) => k.kind === kind)?.name ?? kind;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const accessOf = (source: DatasourceSummary) => sourceAccess(source.access, permissions);
  // The trash lists what the caller may restore: offer it to those who may change a source.
  const canSeeTrash = canCreate || items.some((source) => accessOf(source).write);
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium" });

  const toolbar = trash ? (
    <div className="toolbar">
      <Link to="/data-sources" search={{}} className="versions__back">
        {t("datasources.trash.back")}
      </Link>
    </div>
  ) : canCreate || canSeeTrash ? (
    <div className="toolbar">
      {canCreate ? (
        <Link to="/data-sources/new" search={{}} className="button button--primary">
          {t("datasources.add")}
        </Link>
      ) : null}
      <Link to="/data-sources" search={{ trash: true }} className="versions__back">
        {t("datasources.trash.link")}
      </Link>
    </div>
  ) : null;

  const trashNotice =
    deleted === undefined || trash ? null : (
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
  if (items.length === 0) {
    return (
      <>
        {trashNotice}
        {toolbar}
        {trash ? (
          <EmptyState icon="dataSources" title={t("datasources.trash.empty")}>
            {t("datasources.trash.emptyText")}
          </EmptyState>
        ) : (
          <EmptyState icon="dataSources" title={t("datasources.empty.title")}>
            {canCreate ? t("datasources.empty.text") : t("datasources.empty.textReadOnly")}
          </EmptyState>
        )}
      </>
    );
  }
  return (
    <div className="ds-list">
      {trashNotice}
      <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
      {toolbar}
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("datasources.column.name")}</th>
            <th scope="col">{t("datasources.column.kind")}</th>
            <th scope="col">
              {trash ? t("datasources.column.deleted") : t("datasources.column.created")}
            </th>
            <th scope="col">
              <span className="visually-hidden">{t("datasources.column.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((source) => (
            <DataSourceRow
              key={source.id}
              orgId={orgId}
              source={source}
              kindName={kindName(source.kind)}
              date={dateFormat.format(trash ? (source.deletedAt ?? 0) : source.createdAt)}
              link={accessOf(source).write && !trash}
              canTest={accessOf(source).query && !trash}
              onRestore={trash ? () => restore.mutate(source.id) : undefined}
            />
          ))}
        </tbody>
      </table>
      {list.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {t("datasources.loadMore")}
        </button>
      ) : null}
    </div>
  );
}

function DataSourceRow({
  orgId,
  source,
  kindName,
  date,
  link,
  canTest,
  onRestore,
}: {
  orgId: string;
  source: DatasourceSummary;
  kindName: string;
  date: string;
  link: boolean;
  canTest: boolean;
  onRestore: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const test = useMutation({
    mutationFn: () => checkHealth(orgId, source.id),
    onMutate: () => setHealth(null),
    onSuccess: setHealth,
  });
  return (
    <tr>
      <td>
        {link ? (
          <Link to="/data-sources/$datasourceId" params={{ datasourceId: source.id }}>
            {source.name}
          </Link>
        ) : (
          source.name
        )}
        {canTest ? <HealthResult health={health} error={test.error} /> : null}
      </td>
      <td>
        <KindLabel kind={source.kind} name={kindName} />
      </td>
      <td>{date}</td>
      <td className="data-table__actions">
        {canTest ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => test.mutate()}
            disabled={test.isPending}
            aria-label={t("datasources.health.testNamed", { name: source.name })}
          >
            {test.isPending ? t("datasources.health.testing") : t("datasources.health.test")}
          </button>
        ) : null}
        {onRestore === undefined ? null : (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onRestore}
            aria-label={t("datasources.restoreNamed", { name: source.name })}
          >
            {t("datasources.restore")}
          </button>
        )}
      </td>
    </tr>
  );
}
