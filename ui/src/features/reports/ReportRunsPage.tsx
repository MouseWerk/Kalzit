import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { formatBytes } from "../../lib/bytes";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import {
  fetchRuns,
  REPORTS_KEY,
  type ReportRun,
  reportQuery,
  sendNow,
  setLatestPaused,
} from "./api";
import { runSeconds } from "./model";
import { SendDialog } from "./ReportsPage";
import { codeText, reportErrorText } from "./reasons";
import { ReportsFrame, ReportTabs, StateLabel, useReports, useReportTime } from "./shared";
import "../alerting/alerting.css";
import "./reports.css";

/** A run still on its way: the list reads again until it is done. */
const active = (run: ReportRun) => run.status === "queued" || run.status === "running";
const POLL_MS = 5000;

/**
 * The runs of one report (board Reports.dc.html, frame 5): when, what started it, how long it
 * took, how many recipients got it, the size of the files and the result in words with its
 * reason. Nothing of the files themselves is kept.
 */
export function ReportRunsPage() {
  const { reportId } = useParams({ from: "/_app/reports/$reportId/runs" });
  const { t, language } = useI18n();
  useDocumentTitle("reports.tab.runs");
  const queryClient = useQueryClient();
  const { orgId, status, canWrite } = useReports();
  const report = useQuery({ ...reportQuery(orgId, reportId), enabled: orgId !== "" });
  const runs = useInfiniteQuery({
    queryKey: [REPORTS_KEY, orgId, "runs", reportId],
    queryFn: ({ pageParam, signal }) => fetchRuns(orgId, reportId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: orgId !== "",
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) => page.items.some(active)) === true ? POLL_MS : false,
  });
  const time = useReportTime();
  const [sending, setSending] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: [REPORTS_KEY, orgId] });
  const send = useMutation({
    mutationFn: () => sendNow(orgId, reportId),
    onSuccess: async () => {
      setSending(false);
      showToast({ message: t("reports.queued", { name: report.data?.name ?? "" }) });
      await refresh();
    },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => {
      if (report.data === undefined) throw new Error("no report");
      return setLatestPaused(orgId, report.data, paused);
    },
    onSuccess: async (saved) => {
      showToast({
        message: t(saved.paused ? "reports.paused" : "reports.resumed", { name: saved.name }),
      });
      await refresh();
    },
    onError: async (error) => {
      showToast({ message: reportErrorText(t, error), error: true });
      // The report may be behind what the server has: read it again, so the next try can work.
      await refresh();
    },
  });

  if (report.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (report.isError) {
    return (
      <Page title={t("reports.title")}>
        <EmptyState icon="alert" title={t("reports.notFound")}>
          {reportErrorText(t, report.error)}
        </EmptyState>
      </Page>
    );
  }
  const stored = report.data;
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const sendBlocked = status === undefined || !status.enabled || !status.mailConfigured;
  const seconds = new Intl.NumberFormat(language, {
    style: "unit",
    unit: "second",
    maximumFractionDigits: 1,
  });

  return (
    <ReportsFrame
      title={stored.name}
      crumbs={[{ label: t("reports.title"), link: { to: "/reports" } }, { label: stored.name }]}
      actions={
        canWrite ? (
          <PageActions>
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={pause.isPending || undefined}
              onClick={() => !pause.isPending && pause.mutate(!stored.paused)}
            >
              {t(stored.paused ? "reports.menu.resume" : "reports.menu.pause")}
            </button>
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={sendBlocked || undefined}
              aria-describedby={sendBlocked ? "report-send-why" : undefined}
              onClick={() => !sendBlocked && setSending(true)}
            >
              {t("reports.menu.send")}
            </button>
          </PageActions>
        ) : null
      }
    >
      <ReportTabs reportId={stored.id} />
      {stored.suspended === null ? null : (
        <p className="alert-alarm" role="status">
          <Icon name="alert" />
          <span>
            <strong>{t("reports.suspended.name", { name: stored.name })}</strong>{" "}
            {codeText(t, stored.suspended)} {t("reports.suspended.hint")}
          </span>
        </p>
      )}
      {canWrite && sendBlocked && status !== undefined ? (
        <p className="visually-hidden" id="report-send-why">
          {t(status.enabled ? "reports.reason.mail_not_configured" : "reports.reason.disabled")}
        </p>
      ) : null}
      {runs.isPending ? <p className="loading">{t("common.loading")}</p> : null}
      {runs.isError ? (
        <p className="field__error" role="alert">
          <Icon name="alert" />
          <span>{reportErrorText(t, runs.error)}</span>
        </p>
      ) : null}
      {runs.isSuccess && items.length === 0 ? (
        <p className="alert-card alert-pad alert-muted">
          {stored.nextRunAt === null
            ? t("reports.runs.none")
            : t("reports.runs.noneYet", { at: time.dayTime(stored.nextRunAt) })}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <div className="alert-card alert-table-wrap">
          <table className="alert-table">
            <thead>
              <tr>
                <th scope="col">{t("reports.runs.time")}</th>
                <th scope="col">{t("reports.runs.trigger")}</th>
                <th scope="col" className="alert-num">
                  {t("reports.runs.duration")}
                </th>
                <th scope="col">{t("reports.runs.delivered")}</th>
                <th scope="col" className="alert-num">
                  {t("reports.runs.size")}
                </th>
                <th scope="col">{t("reports.runs.result")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => {
                const took = runSeconds(run);
                return (
                  <tr key={run.id}>
                    <td className="alert-num-left">
                      {time.clock(run.scheduledFor ?? run.createdAt)}
                    </td>
                    <td>
                      {t(run.trigger === "manual" ? "reports.menu.send" : "reports.col.schedule")}
                      {run.attempt > 1 ? (
                        <span className="alert-sub">{t("reports.runs.retry")}</span>
                      ) : null}
                    </td>
                    <td className="alert-num">{took === null ? "–" : seconds.format(took)}</td>
                    <td className="alert-num-left">
                      {active(run) || run.status === "skipped" || run.status === "suspended"
                        ? "–"
                        : t("reports.runs.sent", { sent: run.sent, all: run.recipients })}
                      {run.skippedRecipients > 0 ? (
                        <span className="alert-sub">
                          {t("reports.runs.skipped", { count: run.skippedRecipients })}
                        </span>
                      ) : null}
                      {run.csvWithheld > 0 ? (
                        <span className="alert-sub">
                          {t("reports.runs.pdfOnly", { count: run.csvWithheld })}
                        </span>
                      ) : null}
                    </td>
                    <td className="alert-num">
                      {run.attachmentBytes === null
                        ? "–"
                        : formatBytes(run.attachmentBytes, language)}
                    </td>
                    <td>
                      <StateLabel state={run.status} quiet={run.status === "ok"} />
                      {run.error === null ? null : (
                        <span className="alert-sub">{codeText(t, run.error)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage ? (
        <div className="alert-row-actions report-more">
          <button
            type="button"
            className="button button--secondary button--small"
            aria-disabled={runs.isFetchingNextPage || undefined}
            onClick={() => !runs.isFetchingNextPage && void runs.fetchNextPage()}
          >
            {t("admin.common.showMore")}
          </button>
        </div>
      ) : null}
      <p className="alert-hint">
        {t("reports.runs.footer", { days: status?.limits.historyRetentionDays ?? 90 })}
      </p>
      <SendDialog
        report={sending ? stored : null}
        busy={send.isPending}
        error={send.isError ? reportErrorText(t, send.error) : null}
        onConfirm={() => send.mutate()}
        onClose={() => {
          setSending(false);
          send.reset();
        }}
      />
    </ReportsFrame>
  );
}
