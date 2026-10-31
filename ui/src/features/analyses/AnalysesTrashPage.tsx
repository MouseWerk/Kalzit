import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { ANALYSES_KEY, type Analysis, fetchAnalyses, purgeAnalysis, restoreAnalysis } from "./api";
import "../dashboards/dashboards.css";
import "./analyses.css";

export function AnalysesTrashPage() {
  const { t } = useI18n();
  useDocumentTitle("analyses.trash.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  let body = null;
  if (org !== undefined && permissions.has("analyses:read")) {
    body = <TrashList orgId={org.id} />;
  } else if (permissions.loaded) {
    body = (
      <EmptyState icon="lock" title={t("analyses.forbidden.title")}>
        {t("analyses.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("analyses.trash.title")} lead={t("analyses.trash.lead")}>
      <Breadcrumbs
        crumbs={[
          { label: t("analyses.list.title"), link: { to: "/explore/saved", search: {} } },
          { label: t("analyses.trash.title") },
        ]}
      />
      {body}
    </Page>
  );
}

/**
 * Analyses in the trash: restore, or delete for good (the admin level on the analysis). One that
 * a dashboard still links, a trashed dashboard too, cannot be purged; the server says so.
 */
function TrashList({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const [purging, setPurging] = useState<Analysis | null>(null);
  const list = useInfiniteQuery({
    queryKey: [ANALYSES_KEY, orgId, "trash"],
    queryFn: ({ pageParam, signal }) =>
      fetchAnalyses(orgId, { trashed: true, sort: "updated", cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [ANALYSES_KEY, orgId] });
  const restore = useMutation({
    mutationFn: (analysis: Analysis) => restoreAnalysis(orgId, analysis.id),
    onSuccess: refresh,
  });
  const purge = useMutation({
    mutationFn: (analysis: Analysis) => purgeAnalysis(orgId, analysis.id),
    onSuccess: async () => {
      setPurging(null);
      await refresh();
    },
  });
  const format = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const back = (
    <Link to="/explore/saved" search={{}} className="back-link">
      <Icon name="back" />
      {t("analyses.trash.back")}
    </Link>
  );

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  const items = list.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <>
        {back}
        <EmptyState icon="trash" title={t("analyses.trash.empty")}>
          {t("analyses.trash.emptyText")}
        </EmptyState>
      </>
    );
  }
  return (
    <div className="versions">
      {back}
      <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
      <table className="data-table data-table--stack" {...STACK_ROLES.table}>
        <thead {...STACK_ROLES.rowgroup}>
          <tr {...STACK_ROLES.row}>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.column.name")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.trash.deletedAt")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              <span className="visually-hidden">{t("analyses.column.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody {...STACK_ROLES.rowgroup}>
          {items.map((item) => (
            <tr key={item.id} {...STACK_ROLES.row}>
              <td {...STACK_ROLES.cell}>
                {item.title}
                {item.uses === 0 ? null : (
                  <span className="data-table__muted">
                    {" "}
                    {t(item.uses === 1 ? "analyses.list.usesOne" : "analyses.list.usesMany", {
                      count: item.uses,
                    })}
                  </span>
                )}
              </td>
              <td {...STACK_ROLES.cell} data-label={t("analyses.trash.deletedAt")}>
                {item.deletedAt === null ? "" : format.format(item.deletedAt)}
              </td>
              <td {...STACK_ROLES.cell} className="data-table__actions">
                {item.access.write ? (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => restore.mutate(item)}
                    disabled={restore.isPending}
                    aria-label={t("analyses.trash.restoreNamed", { title: item.title })}
                  >
                    {t("analyses.trash.restore")}
                  </button>
                ) : null}{" "}
                {item.access.delete ? (
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => {
                      purge.reset();
                      setPurging(item);
                    }}
                    aria-label={t("analyses.trash.purgeNamed", { title: item.title })}
                  >
                    {t("analyses.trash.purge")}
                  </button>
                ) : null}
              </td>
            </tr>
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
          {t("analyses.list.loadMore")}
        </button>
      ) : null}
      {purging === null ? null : (
        <ConfirmDialog
          title={t("analyses.trash.purgeTitle")}
          confirmLabel={t("analyses.trash.purgeConfirm")}
          onCancel={() => setPurging(null)}
          onConfirm={() => purge.mutate(purging)}
          busy={purge.isPending}
          error={purge.isError ? errorMessage(t, purge.error) : undefined}
        >
          {t("analyses.trash.purgeText", { title: purging.title })}
        </ConfirmDialog>
      )}
    </div>
  );
}
