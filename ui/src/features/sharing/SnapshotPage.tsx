import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg } from "../../org/useOrg";
import { LoadState } from "../admin/components/Section";
import { snapshotQuery } from "./api";
import { dateText, dateTimeText, fixedRangeText } from "./model";
import { FrozenBoard } from "./PublicPages";
import { FixedValues } from "./SharedBoard";
import "./sharing.css";

/**
 * A snapshot inside the organization (board Sharing.dc.html, frame 10): in the app, for members
 * who may read its dashboard. A quiet line says who froze it when and until when it stays; the
 * way back to the live dashboard is one button.
 */
export function SnapshotPage() {
  const { t, language, timeZone } = useI18n();
  const { dashboardId, snapshotId } = useParams({ strict: false }) as {
    dashboardId: string;
    snapshotId: string;
  };
  const org = useCurrentOrg();
  const view = useQuery({
    ...snapshotQuery(org?.id ?? "", snapshotId),
    enabled: org !== undefined,
  });
  const title = view.data?.snapshot.title;
  const product = t("app.documentTitle", { page: title ?? t("sharing.tab.snapshot") });
  useEffect(() => {
    document.title = product;
  }, [product]);

  if (view.data === undefined) {
    if (view.isError && isApiError(view.error, "not_found")) {
      // Revoked, expired or never there: one answer for all, as the server gives it.
      return (
        <div className="page">
          <EmptyState
            icon="clock"
            title={t("sharing.snapshot.goneTitle")}
            actions={
              <Link
                to="/dashboards/$dashboardId"
                params={{ dashboardId }}
                search={{}}
                className="button button--secondary"
              >
                {t("sharing.snapshot.toLive")}
              </Link>
            }
          >
            {t("sharing.snapshot.goneText")}
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="page">
        <LoadState error={view.error} onRetry={() => void view.refetch()} />
      </div>
    );
  }
  const { snapshot, dashboard, results } = view.data;
  const made = dateTimeText(snapshot.createdAt, language, timeZone);
  const source = snapshot.dashboardTitle ?? dashboard.title;
  return (
    <div className="share-snapshot">
      <Breadcrumbs
        crumbs={[
          { label: t("dashboards.title"), link: { to: "/dashboards", search: {} } },
          {
            label: source,
            link: { to: "/dashboards/$dashboardId", params: { dashboardId }, search: {} },
          },
          { label: t("sharing.snapshot.crumb") },
          { label: made },
        ]}
      />
      <div className="share-snapshot__bar">
        <h1 className="share-snapshot__title truncate" title={snapshot.title}>
          {snapshot.title}
        </h1>
        <span className="share-page__range">
          {fixedRangeText(snapshot.timeRange, language, timeZone)}
        </span>
        <FixedValues dashboard={dashboard} />
        <Link
          to="/dashboards/$dashboardId"
          params={{ dashboardId }}
          search={{}}
          className="button button--secondary share-snapshot__live"
        >
          {t("sharing.snapshot.toLive")}
        </Link>
      </div>
      <p className="share-snapshot__note">
        <Icon name="lock" />
        <span>
          {t(
            snapshot.createdByName === null
              ? "sharing.snapshot.frozenNote"
              : "sharing.snapshot.frozenNoteBy",
            {
              date: made,
              name: snapshot.createdByName ?? "",
              scope: t(snapshot.public ? "sharing.scope.publicLower" : "sharing.scope.orgLower"),
              expires: dateText(snapshot.expiresAt, language, timeZone),
              dashboard: source,
            },
          )}
        </span>
      </p>
      <FrozenBoard dashboard={dashboard} results={results} range={snapshot.timeRange} />
    </div>
  );
}
