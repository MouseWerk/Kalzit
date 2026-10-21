import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import {
  DASHBOARDS_KEY,
  type DashboardVersion,
  dashboardQuery,
  fetchVersionModel,
  fetchVersions,
  restoreVersion,
} from "./api";
import "./dashboards.css";
import { type Change, diffModels } from "./diff";
import type { DashboardModel } from "./model";
import { changeText } from "./SaveDialogs";
import { ConfirmDialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";

const versionsRoute = getRouteApi("/_app/dashboards/$dashboardId/versions");

export function VersionsPage() {
  const { t } = useI18n();
  useDocumentTitle("dashboards.history.title");
  const org = useCurrentOrg();
  return (
    <Page title={t("dashboards.history.title")} lead={t("dashboards.history.lead")}>
      {org === undefined ? null : <VersionList orgId={org.id} />}
    </Page>
  );
}

function VersionList({ orgId }: { orgId: string }) {
  const { t, language } = useI18n();
  const { dashboardId } = versionsRoute.useParams();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dashboard = useQuery(dashboardQuery(orgId, dashboardId));
  const versions = useInfiniteQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "versions", dashboardId],
    queryFn: ({ pageParam }) => fetchVersions(orgId, dashboardId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [confirm, setConfirm] = useState<DashboardVersion | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const restore = useMutation({
    mutationFn: (version: number) => restoreVersion(orgId, dashboardId, version),
    onSuccess: async () => {
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      await navigate({ to: "/dashboards/$dashboardId", params: { dashboardId }, search: {} });
    },
  });
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  const canRestore = permissions.has("dashboards:write") && dashboard.data?.deletedAt === null;

  if (versions.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (versions.isError) {
    return <FormAlert>{errorMessage(t, versions.error)}</FormAlert>;
  }
  const items = versions.data.pages.flatMap((page) => page.items);
  const currentVersion = dashboard.data?.version;
  return (
    <div className="versions">
      <Link
        to="/dashboards/$dashboardId"
        params={{ dashboardId }}
        search={{}}
        className="versions__back"
      >
        {t("dashboards.history.back", { title: dashboard.data?.title ?? "" })}
      </Link>
      {items.length === 0 ? (
        <EmptyState icon="dashboards" title={t("dashboards.history.empty")}>
          {t("dashboards.history.emptyText")}
        </EmptyState>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t("dashboards.history.version")}</th>
              <th scope="col">{t("dashboards.history.saved")}</th>
              <th scope="col">{t("dashboards.history.message")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("dashboards.history.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.version}>
                <td>
                  {item.version}
                  {item.version === currentVersion ? (
                    <span className="data-table__muted"> {t("dashboards.history.current")}</span>
                  ) : null}
                </td>
                <td>
                  {format.format(item.createdAt)}
                  {item.authorName === null ? null : (
                    <span className="data-table__muted">
                      {" "}
                      {t("dashboards.updatedBy", { name: item.authorName })}
                    </span>
                  )}
                  {item.restoredFrom === null ? null : (
                    <span className="data-table__muted">
                      {" "}
                      {t("dashboards.history.restoredFrom", { version: item.restoredFrom })}
                    </span>
                  )}
                </td>
                <td>
                  {item.message === "" ? (
                    <span className="data-table__muted">{t("dashboards.history.noMessage")}</span>
                  ) : (
                    item.message
                  )}
                </td>
                <td className="data-table__actions">
                  {item.version === currentVersion ? null : (
                    <>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-expanded={compare === item.version}
                        onClick={() => setCompare(compare === item.version ? null : item.version)}
                      >
                        {t("dashboards.history.compare")}
                      </button>
                      {canRestore ? (
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          onClick={() => setConfirm(item)}
                        >
                          {t("dashboards.history.restore")}
                        </button>
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {compare === null || dashboard.data === undefined ? null : (
        <VersionCompare
          orgId={orgId}
          dashboardId={dashboardId}
          version={compare}
          current={dashboard.data.model}
        />
      )}
      {versions.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void versions.fetchNextPage()}
        >
          {t("dashboards.loadMore")}
        </button>
      ) : null}
      {confirm === null ? null : (
        <ConfirmDialog
          title={t("dashboards.history.restoreTitle")}
          confirmLabel={t("dashboards.history.restoreConfirm")}
          onCancel={() => setConfirm(null)}
          onConfirm={() => restore.mutate(confirm.version)}
          busy={restore.isPending}
          error={restore.isError ? errorMessage(t, restore.error) : undefined}
        >
          {t("dashboards.history.restoreText", { version: confirm.version })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function VersionCompare({
  orgId,
  dashboardId,
  version,
  current,
}: {
  orgId: string;
  dashboardId: string;
  version: number;
  current: DashboardModel;
}) {
  const { t } = useI18n();
  const old = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "version", dashboardId, version],
    queryFn: () => fetchVersionModel(orgId, dashboardId, version),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (old.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (old.isError) {
    return <FormAlert>{errorMessage(t, old.error)}</FormAlert>;
  }
  const changes: Change[] = diffModels(old.data, current);
  return (
    <section
      className="versions__compare"
      aria-label={t("dashboards.history.compareTitle", { version })}
    >
      <h2 className="section-title">{t("dashboards.history.compareTitle", { version })}</h2>
      {changes.length === 0 ? (
        <p className="field__hint">{t("dashboards.diff.none")}</p>
      ) : (
        <ul className="conflict__list">
          {changes.map((change, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <li key={index}>{changeText(t, change)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
