import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import {
  DASHBOARDS_KEY,
  FOLDERS_KEY,
  fetchDashboards,
  fetchTrashedFolders,
  foldersQuery,
  purgeDashboard,
  purgeFolder,
  restoreDashboard,
  restoreFolder,
} from "./api";
import "./dashboards.css";
import { zoned } from "../../preferences/preferences";
import { ConfirmDialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";

export function TrashPage() {
  const { t } = useI18n();
  useDocumentTitle("dashboards.trash.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  let body = null;
  if (org !== undefined && permissions.has("dashboards:delete")) {
    body = <TrashList orgId={org.id} canFolders={permissions.has("folders:write")} />;
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

interface TrashItem {
  kind: "folder" | "dashboard";
  id: string;
  name: string;
  deletedAt: number | null;
}

/** Trashed folders (each with what was trashed with it) and dashboards: restore or purge. */
function TrashList({ orgId, canFolders }: { orgId: string; canFolders: boolean }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const [purging, setPurging] = useState<TrashItem | null>(null);
  const dashboards = useInfiniteQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "trash"],
    queryFn: ({ pageParam, signal }) =>
      fetchDashboards(orgId, { trashed: true, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const folders = useQuery({
    queryKey: [FOLDERS_KEY, orgId, "trash"],
    queryFn: ({ signal }) => fetchTrashedFolders(orgId, signal),
    enabled: canFolders,
  });
  // Folders not in the trash: a dashboard whose folder is among them was not trashed with a
  // folder, whatever the time.
  const liveFolders = useQuery({ ...foldersQuery(orgId), enabled: canFolders });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
    await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
  };
  const restore = useMutation({
    mutationFn: (item: TrashItem) =>
      item.kind === "folder" ? restoreFolder(orgId, item.id) : restoreDashboard(orgId, item.id),
    onSuccess: refresh,
  });
  const purge = useMutation({
    mutationFn: (item: TrashItem) =>
      item.kind === "folder" ? purgeFolder(orgId, item.id) : purgeDashboard(orgId, item.id),
    onSuccess: async () => {
      setPurging(null);
      await refresh();
    },
  });
  const format = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoned(),
  });

  if (dashboards.isPending || (canFolders && (folders.isPending || liveFolders.isPending))) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (dashboards.isError || folders.isError) {
    return <FormAlert>{errorMessage(t, dashboards.error ?? folders.error)}</FormAlert>;
  }
  // A folder is trashed with everything below it at one moment and restored the same way. A
  // dashboard goes with a listed folder when both were trashed at that moment and its folder is
  // that folder or lies below it, which shows as a folder that is no longer live. Every other
  // trashed dashboard is listed on its own, whether or not its folder is in the caller's list.
  const trashedAt = new Map((folders.data ?? []).map((f) => [f.deletedAt, f.id]));
  const live = new Set((liveFolders.data ?? []).map((f) => f.id));
  const wentWithFolder = (d: { folderId: string | null; deletedAt: number | null }) => {
    const folder = trashedAt.get(d.deletedAt);
    return (
      folder !== undefined &&
      d.folderId !== null &&
      (d.folderId === folder || !live.has(d.folderId))
    );
  };
  const items: TrashItem[] = [
    ...(folders.data ?? []).map((f) => ({
      kind: "folder" as const,
      id: f.id,
      name: f.name,
      deletedAt: f.deletedAt,
    })),
    ...dashboards.data.pages
      .flatMap((page) => page.items)
      .filter((d) => !wentWithFolder(d))
      .map((d) => ({
        kind: "dashboard" as const,
        id: d.id,
        name: d.title === "" ? t("dashboards.untitled") : d.title,
        deletedAt: d.deletedAt,
      })),
  ];
  const back = (
    <Link to="/dashboards" className="versions__back">
      {t("dashboards.backToList")}
    </Link>
  );
  if (items.length === 0) {
    return (
      <>
        {back}
        <EmptyState icon="dashboards" title={t("dashboards.trash.empty")}>
          {t("dashboards.trash.emptyText")}
        </EmptyState>
      </>
    );
  }
  const failed = restore.error ?? purge.error;
  return (
    <div className="versions">
      {back}
      <FormAlert>{failed === null ? null : errorMessage(t, failed)}</FormAlert>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{t("dashboards.trash.name")}</th>
            <th scope="col">{t("dashboards.trash.kind")}</th>
            <th scope="col">{t("dashboards.trash.deletedAt")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("dashboards.history.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={`${item.kind}:${item.id}`}>
              <td>{item.name}</td>
              <td>
                {item.kind === "folder"
                  ? t("dashboards.trash.kindFolder")
                  : t("dashboards.trash.kindDashboard")}
              </td>
              <td>{item.deletedAt === null ? "" : format.format(item.deletedAt)}</td>
              <td className="data-table__actions">
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => restore.mutate(item)}
                  disabled={restore.isPending}
                  aria-label={t("dashboards.trash.restoreNamed", { title: item.name })}
                >
                  {t("dashboards.trash.restore")}
                </button>{" "}
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => setPurging(item)}
                  aria-label={t("dashboards.trash.purgeNamed", { title: item.name })}
                >
                  {t("dashboards.trash.purge")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dashboards.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void dashboards.fetchNextPage()}
          disabled={dashboards.isFetchingNextPage}
        >
          {t("dashboards.loadMore")}
        </button>
      ) : null}
      {purging === null ? null : (
        <ConfirmDialog
          title={t("dashboards.trash.purgeTitle")}
          confirmLabel={t("dashboards.trash.purgeConfirm")}
          onCancel={() => {
            purge.reset();
            setPurging(null);
          }}
          onConfirm={() => purge.mutate(purging)}
          busy={purge.isPending}
          error={purge.isError ? errorMessage(t, purge.error) : undefined}
        >
          {purging.kind === "folder"
            ? t("dashboards.trash.purgeFolderText", { title: purging.name })
            : t("dashboards.trash.purgeText", { title: purging.name })}
        </ConfirmDialog>
      )}
    </div>
  );
}
