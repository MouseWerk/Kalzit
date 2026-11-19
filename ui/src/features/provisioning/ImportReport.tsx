import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { isApiError } from "../../api/client";
import type { ImportItem, ImportReport, ItemKind, ItemStatus } from "../../api/generated/shapes";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
import { zoneOption } from "../../lib/timeSettings";
import { useCurrentOrg } from "../../org/useOrg";
import { LoadState } from "../admin/components/Section";
import { dashboardQuery } from "../dashboards/api";
import { importReportQuery } from "./api";
import { noticeKey, parseNotice } from "./importNotice";
import "../admin/admin.css";
import "./provisioning.css";

const STATUSES: readonly ItemStatus[] = ["converted", "approximated", "skipped"];

const STATUS_TEXT: Record<ItemStatus, MessageKey> = {
  converted: "provisioning.import.converted",
  approximated: "provisioning.import.approximated",
  skipped: "provisioning.import.skipped",
};

const STATUS_HINT: Record<ItemStatus, MessageKey> = {
  converted: "provisioning.import.convertedHint",
  approximated: "provisioning.import.approximatedHint",
  skipped: "provisioning.import.skippedHint",
};

const KIND_TEXT: Record<ItemKind, MessageKey> = {
  dashboard: "provisioning.item.dashboard",
  panel: "provisioning.item.panel",
  row: "provisioning.item.row",
  query: "provisioning.item.query",
  variable: "provisioning.item.variable",
  annotation: "provisioning.item.annotation",
  link: "provisioning.item.link",
};

type Filter = "all" | "converted" | "changed";

/** The panels of a report by what became of them, for the summary lines. */
export function panelCounts(report: ImportReport): Record<ItemStatus, number> {
  const of = (status: ItemStatus) =>
    report.items.filter((item) => item.kind === "panel" && item.status === status).length;
  return { converted: of("converted"), approximated: of("approximated"), skipped: of("skipped") };
}

/**
 * What an import makes of a Grafana dashboard (board Provisioning.dc.html, frame 11): how much
 * is converted, approximated and skipped, then every item with what changed or why it was left
 * out. The item names and notes are the server's own words.
 */
export function ReportView({ report }: { report: ImportReport }) {
  const { t } = useI18n();
  const groupId = useId();
  const [filter, setFilter] = useState<Filter>(
    report.counts.approximated + report.counts.skipped > 0 ? "changed" : "all",
  );
  const shown = (status: ItemStatus) =>
    filter === "all" || (filter === "converted") === (status === "converted");
  const groups = STATUSES
    // What needs a look comes first.
    .toSorted((a, b) => Number(a === "converted") - Number(b === "converted"))
    .filter(shown)
    .map((status) => ({
      status,
      items: report.items.filter((item) => item.status === status),
    }))
    .filter((group) => group.items.length > 0);
  return (
    <div className="prov-report">
      <ul className="prov-report__counts">
        {STATUSES.map((status) => (
          <li key={status} className="prov-report__count">
            <span className="prov-report__label">{t(STATUS_TEXT[status])}</span>
            <span className="prov-report__number">{report.counts[status]}</span>
            <span className="prov-report__hint">{t(STATUS_HINT[status])}</span>
          </li>
        ))}
      </ul>
      <fieldset className="admin-segmented">
        <legend className="visually-hidden">{t("provisioning.import.filter")}</legend>
        {(
          [
            ["all", "provisioning.import.filterAll"],
            ["converted", "provisioning.import.converted"],
            ["changed", "provisioning.import.filterChanged"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="admin-segmented__option">
            <input
              type="radio"
              className="visually-hidden"
              name={groupId}
              checked={filter === value}
              onChange={() => setFilter(value)}
            />
            {t(label)}
          </label>
        ))}
      </fieldset>
      {groups.length === 0 ? (
        <p className="prov-block__empty">{t("provisioning.import.nothingHere")}</p>
      ) : (
        <div className="admin-table-card">
          <table className="admin-table prov-report__table">
            <thead>
              <tr>
                <th scope="col">{t("provisioning.import.element")}</th>
                <th scope="col">{t("provisioning.import.kind")}</th>
                <th scope="col">{t("provisioning.import.different")}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.status}>
                <tr className="prov-report__group">
                  <th scope="rowgroup" colSpan={3}>
                    {t(STATUS_TEXT[group.status])}
                    <span className="prov-report__group-count">{group.items.length}</span>
                  </th>
                </tr>
                {group.items.map((item: ImportItem, index) => (
                  // Names repeat (two panels of one title); the report's order does not change.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                  <tr key={index}>
                    <th scope="row" className="prov-report__name">
                      {item.name}
                    </th>
                    <td>{t(KIND_TEXT[item.kind])}</td>
                    <td className="prov-report__notes">
                      {item.notes.length === 0
                        ? "–"
                        : item.notes.map((note, at) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: notes are a fixed list.
                            <span key={at} className="prov-report__note">
                              {note}
                            </span>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

/** The report of the import that made a dashboard; it stays with the dashboard. */
export function ImportReportPage() {
  const { t, language, timeZone } = useI18n();
  const { dashboardId } = useParams({ strict: false }) as { dashboardId: string };
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const dashboard = useQuery({ ...dashboardQuery(orgId, dashboardId), enabled: orgId !== "" });
  const stored = useQuery({
    ...importReportQuery(orgId, dashboardId),
    enabled: orgId !== "",
  });
  const title = t("provisioning.import.reportTitle");
  const documentTitle = t("app.documentTitle", { page: title });
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);
  const name = dashboard.data?.title ?? "";
  const back = (
    <Link
      to="/dashboards/$dashboardId"
      params={{ dashboardId }}
      search={{}}
      className="button button--secondary"
    >
      {t("provisioning.import.toDashboard")}
    </Link>
  );
  return (
    <div className="page prov-page">
      <Breadcrumbs
        crumbs={[
          { label: t("dashboards.title"), link: { to: "/dashboards", search: {} } },
          {
            label: name === "" ? t("dashboards.untitled") : name,
            link: { to: "/dashboards/$dashboardId", params: { dashboardId }, search: {} },
          },
          { label: title },
        ]}
      />
      <div className="page__top">
        <div className="page__header">
          <h1>{title}</h1>
          {stored.data === undefined ? null : (
            <p className="page__lead">
              {t("provisioning.import.reportLead", {
                source: stored.data.report.title,
                date: new Intl.DateTimeFormat(language, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  ...zoneOption(timeZone),
                }).format(stored.data.createdAt),
              })}
            </p>
          )}
        </div>
        <div className="page__actions">{back}</div>
      </div>
      {stored.data !== undefined ? (
        <ReportView report={stored.data.report} />
      ) : isApiError(stored.error, "not_found") ? (
        <EmptyState icon="file" title={t("provisioning.import.noReportTitle")}>
          {t("provisioning.import.noReportText")}
        </EmptyState>
      ) : (
        <LoadState error={stored.error} onRetry={() => void stored.refetch()} />
      )}
    </div>
  );
}

/**
 * The quiet line on a dashboard that just came from an import (board frame 12): what was made,
 * the way to the report, and a way to put the line away.
 */
export function ImportNoticeBar({ dashboardId }: { dashboardId: string }) {
  const { t, language, timeZone } = useI18n();
  const [notice, setNotice] = useState(() => parseNotice(readPreference(noticeKey(dashboardId))));
  if (notice === null) {
    return null;
  }
  return (
    <output className="prov-notice">
      <span className="prov-notice__text">
        {t("provisioning.notice.text", {
          date: new Intl.DateTimeFormat(language, {
            dateStyle: "medium",
            ...zoneOption(timeZone),
          }).format(notice.at),
          created: notice.converted + notice.approximated,
          approximated: notice.approximated,
          skipped: notice.skipped,
        })}
      </span>
      <Link
        to="/dashboards/$dashboardId/import-report"
        params={{ dashboardId }}
        className="prov-notice__link"
      >
        {t("provisioning.notice.report")}
      </Link>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={() => {
          writePreference(noticeKey(dashboardId), "");
          setNotice(null);
        }}
      >
        {t("provisioning.notice.hide")}
      </button>
    </output>
  );
}
