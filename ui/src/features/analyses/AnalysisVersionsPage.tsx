import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg } from "../../org/useOrg";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import {
  ANALYSES_KEY,
  type AnalysisModel,
  type AnalysisVersion,
  analysisQuery,
  fetchVersionModel,
  fetchVersions,
  restoreVersion,
} from "./api";
import { analysisChanges } from "./changes";
import "../dashboards/dashboards.css";
import "./analyses.css";

const versionsRoute = getRouteApi("/_app/explore/saved/$analysisId/versions");

export function AnalysisVersionsPage() {
  const { t } = useI18n();
  useDocumentTitle("analyses.versions.title");
  const org = useCurrentOrg();
  return (
    <Page title={t("analyses.versions.title")} lead={t("analyses.versions.lead")}>
      {org === undefined ? null : <VersionList orgId={org.id} />}
    </Page>
  );
}

/** Every save of an analysis, newest first: compare one with the current version, or restore it. */
function VersionList({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const { analysisId } = versionsRoute.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const analysis = useQuery(analysisQuery(orgId, analysisId));
  const versions = useInfiniteQuery({
    queryKey: [ANALYSES_KEY, orgId, "versions", analysisId],
    queryFn: ({ pageParam, signal }) =>
      fetchVersions(orgId, analysisId, { cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [confirm, setConfirm] = useState<AnalysisVersion | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const seen = analysis.data?.version;
  const restore = useMutation({
    mutationFn: ({ version, expected }: { version: number; expected: number }) =>
      restoreVersion(orgId, analysisId, version, expected),
    onSuccess: async () => {
      setConfirm(null);
      await queryClient.invalidateQueries({ queryKey: [ANALYSES_KEY, orgId] });
      await navigate({ to: "/explore", search: { analysis: analysisId } });
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: [ANALYSES_KEY, orgId] }),
  });
  const format = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const canRestore =
    seen !== undefined && analysis.data?.access.write === true && analysis.data.deletedAt === null;

  if (versions.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (versions.isError) {
    return <FormAlert>{errorMessage(t, versions.error)}</FormAlert>;
  }
  const items = versions.data.pages.flatMap((page) => page.items);
  return (
    <div className="versions">
      <Link
        to={analysis.data?.mayQuery === true ? "/explore" : "/explore/saved"}
        search={analysis.data?.mayQuery === true ? { analysis: analysisId } : {}}
        className="back-link"
      >
        <Icon name="back" />
        {t("analyses.versions.back", { title: analysis.data?.title ?? "" })}
      </Link>
      {items.length === 0 ? (
        <EmptyState icon="history" title={t("analyses.versions.empty")}>
          {t("analyses.versions.emptyText")}
        </EmptyState>
      ) : (
        <table className="data-table data-table--stack" {...STACK_ROLES.table}>
          <thead {...STACK_ROLES.rowgroup}>
            <tr {...STACK_ROLES.row}>
              <th scope="col" {...STACK_ROLES.columnheader}>
                {t("analyses.versions.version")}
              </th>
              <th scope="col" {...STACK_ROLES.columnheader}>
                {t("analyses.versions.saved")}
              </th>
              <th scope="col" {...STACK_ROLES.columnheader}>
                <span className="visually-hidden">{t("analyses.column.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody {...STACK_ROLES.rowgroup}>
            {items.map((item) => (
              <tr key={item.version} {...STACK_ROLES.row}>
                <td {...STACK_ROLES.cell} data-label={t("analyses.versions.version")}>
                  {item.version}
                  {item.version === seen ? (
                    <span className="data-table__muted"> {t("analyses.versions.current")}</span>
                  ) : null}
                </td>
                <td {...STACK_ROLES.cell} data-label={t("analyses.versions.saved")}>
                  {format.format(item.createdAt)}
                  {item.authorName === null ? null : (
                    <span className="data-table__muted">
                      {" "}
                      {t("analyses.list.by", { name: item.authorName })}
                    </span>
                  )}
                  {item.restoredFrom === null ? null : (
                    <span className="data-table__muted">
                      {" "}
                      {t("analyses.versions.restoredFrom", { version: item.restoredFrom })}
                    </span>
                  )}
                </td>
                <td {...STACK_ROLES.cell} className="data-table__actions">
                  {item.version === seen ? null : (
                    <>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-expanded={compare === item.version}
                        aria-label={t("analyses.versions.compareNamed", { version: item.version })}
                        onClick={() => setCompare(compare === item.version ? null : item.version)}
                      >
                        {t("analyses.versions.compare")}
                      </button>
                      {canRestore ? (
                        <button
                          type="button"
                          className="button button--secondary button--small"
                          aria-label={t("analyses.versions.restoreNamed", {
                            version: item.version,
                          })}
                          onClick={() => {
                            restore.reset();
                            setConfirm(item);
                          }}
                        >
                          {t("analyses.versions.restore")}
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
      {compare === null || analysis.data?.model === undefined ? null : (
        <VersionCompare
          orgId={orgId}
          analysisId={analysisId}
          version={compare}
          current={analysis.data.model}
        />
      )}
      {versions.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void versions.fetchNextPage()}
        >
          {t("analyses.list.loadMore")}
        </button>
      ) : null}
      {confirm === null ? null : (
        <ConfirmDialog
          title={t("analyses.versions.restoreTitle")}
          confirmLabel={t("analyses.versions.restoreConfirm")}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (seen !== undefined) {
              restore.mutate({ version: confirm.version, expected: seen });
            }
          }}
          busy={restore.isPending || seen === undefined}
          error={
            !restore.isError
              ? undefined
              : isApiError(restore.error, "version_conflict")
                ? t("analyses.versions.restoreConflict")
                : errorMessage(t, restore.error)
          }
        >
          {t("analyses.versions.restoreText", { version: confirm.version })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function VersionCompare({
  orgId,
  analysisId,
  version,
  current,
}: {
  orgId: string;
  analysisId: string;
  version: number;
  current: AnalysisModel;
}) {
  const { t } = useI18n();
  const old = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "version", analysisId, version],
    queryFn: ({ signal }) => fetchVersionModel(orgId, analysisId, version, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (old.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (old.isError) {
    return <FormAlert>{errorMessage(t, old.error)}</FormAlert>;
  }
  const changes = analysisChanges(t, old.data, current);
  return (
    <section
      className="versions__compare"
      aria-label={t("analyses.versions.compareTitle", { version })}
    >
      <h2 className="section-title">{t("analyses.versions.compareTitle", { version })}</h2>
      {changes.length === 0 ? (
        <p className="field__hint">{t("analyses.conflict.none")}</p>
      ) : (
        <ul className="conflict__list">
          {changes.map((change) => (
            <li key={`${change.key}:${JSON.stringify(change.params ?? {})}`}>
              {t(change.key, change.params ?? {})}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
