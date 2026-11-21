import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { appRoute } from "../../app/baseRoutes";
import { CutText } from "../../components/CutText";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { PageActions } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { browserZone } from "../../lib/timeSettings";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { ConfirmDialog, Dialog } from "../admin/components/Dialog";
import {
  deleteReport,
  REPORTS_KEY,
  type Report,
  reportsQuery,
  sendNow,
  setLatestPaused,
} from "./api";
import { formatsText, hasProblem, reachable, recipientsText, scheduleText } from "./model";
import { codeText, reportErrorText } from "./reasons";
import { REPORT_FILTERS, type ReportFilter, type ReportsSearch } from "./routes";
import { ReportsFrame, StateLabel, useReports, useReportTime } from "./shared";
import "../alerting/alerting.css";
import "./reports.css";

type Filter = ReportFilter | "all";
const FILTERS: readonly Filter[] = ["all", ...REPORT_FILTERS];

/**
 * "Berichte" (board Reports.dc.html, frames 1, 7 and 9): the reports of the organization with
 * what they send, when, to whom and with whose rights; suspended and paused ones say so in
 * words. The row menu holds the actions; a suspended report explains itself under the list.
 */
export function ReportsPage() {
  const { t, language, timeZone } = useI18n();
  useDocumentTitle("reports.title");
  const search = useSearch({ from: "/_app/reports" }) as ReportsSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { me } = appRoute.useRouteContext();
  const { orgId, permissions, status, canWrite, manages } = useReports();
  const readable = permissions.has("reports:read");
  const reports = useQuery({ ...reportsQuery(orgId), enabled: readable && orgId !== "" });
  const time = useReportTime();
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState<Report | null>(null);
  const [sending, setSending] = useState<Report | null>(null);
  const filter: Filter = search.filter ?? "all";
  const refresh = () => queryClient.invalidateQueries({ queryKey: [REPORTS_KEY, orgId] });

  const remove = useMutation({
    mutationFn: (report: Report) => deleteReport(orgId, report.id),
    onSuccess: async (_, report) => {
      setDeleting(null);
      showToast({ message: t("reports.deleted", { name: report.name }) });
      await refresh();
    },
  });
  const send = useMutation({
    mutationFn: (report: Report) => sendNow(orgId, report.id),
    onSuccess: async (_, report) => {
      setSending(null);
      showToast({ message: t("reports.queued", { name: report.name }) });
      await refresh();
    },
  });
  const pause = useMutation({
    mutationFn: ({ report, paused }: { report: Report; paused: boolean }) =>
      setLatestPaused(orgId, report, paused),
    onSuccess: async (saved) => {
      showToast({
        message: t(saved.paused ? "reports.paused" : "reports.resumed", { name: saved.name }),
      });
      await refresh();
    },
    onError: async (error) => {
      showToast({ message: reportErrorText(t, error), error: true });
      // The list may be behind what the server has: read it again, so the next try can work.
      await refresh();
    },
  });

  const all = reports.data ?? [];
  const matches = (report: Report, f: Filter) =>
    f === "all" || (f === "mine" ? report.ownerId === me.id : hasProblem(report));
  const needle = text.trim().toLowerCase();
  const onDashboard = all.filter(
    (report) => search.dashboard === undefined || report.dashboardId === search.dashboard,
  );
  const shown = onDashboard.filter(
    (report) =>
      matches(report, filter) &&
      (needle === "" ||
        report.name.toLowerCase().includes(needle) ||
        report.dashboardTitle.toLowerCase().includes(needle)),
  );
  const suspended = shown.filter((report) => report.suspended !== null);
  const full = status !== undefined && status.reports >= status.limits.maxReportsPerOrg;
  const sendBlocked = status === undefined || !status.enabled || !status.mailConfigured;

  const add = canWrite ? (
    full ? (
      <button type="button" className="button button--primary" aria-disabled="true">
        <Icon name="plus" />
        {t("reports.new")}
      </button>
    ) : (
      <Link to="/reports/new" search={{}} className="button button--primary">
        <Icon name="plus" />
        {t("reports.new")}
      </Link>
    )
  ) : null;
  const frame = {
    title: t("reports.title"),
    lead: t("reports.lead"),
    crumbs: [{ label: t("reports.title") }],
    actions: add === null ? null : <PageActions>{add}</PageActions>,
  };

  if (reports.isSuccess && all.length === 0) {
    return (
      <ReportsFrame {...frame}>
        <EmptyState icon="file" title={t("reports.empty.title")} actions={add ?? undefined}>
          {t("reports.empty.text")}
        </EmptyState>
        {canWrite ? <p className="alert-hint">{t("reports.tip")}</p> : null}
      </ReportsFrame>
    );
  }

  return (
    <ReportsFrame {...frame}>
      {full && canWrite ? (
        <p className="alert-note" role="status">
          <Icon name="info" />
          {t("reports.reason.too_many", { max: status?.limits.maxReportsPerOrg ?? 0 })}
        </p>
      ) : null}
      <div className="alert-toolbar">
        <label className="alert-search report-search">
          <Icon name="search" />
          <span className="visually-hidden">{t("reports.search")}</span>
          <input
            type="search"
            className="input"
            placeholder={t("reports.searchPlaceholder")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's field set */}
        <div className="alert-filters" role="group" aria-label={t("reports.filter.label")}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="alert-filter"
              aria-pressed={filter === f}
              onClick={() =>
                void navigate({
                  to: "/reports",
                  search: { ...search, filter: f === "all" ? undefined : f },
                })
              }
            >
              {t(`reports.filter.${f}`)}
              <span className="tabs__count">
                {onDashboard.filter((report) => matches(report, f)).length}
              </span>
            </button>
          ))}
        </div>
        <span className="alert-muted report-zone">
          {t("reports.zone", { zone: timeZone ?? browserZone() })}
        </span>
      </div>
      {search.dashboard === undefined ? null : (
        <p className="alert-note">
          {onDashboard[0] === undefined
            ? null
            : `${t("reports.onDashboard", { name: onDashboard[0].dashboardTitle })} `}
          <Link to="/reports" search={{ ...search, dashboard: undefined }}>
            {t("reports.allReports")}
          </Link>
        </p>
      )}
      {reports.isPending && readable ? <p className="loading">{t("common.loading")}</p> : null}
      {reports.isError ? (
        <p className="field__error" role="alert">
          <Icon name="alert" />
          <span>{reportErrorText(t, reports.error)}</span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void reports.refetch()}
          >
            {t("common.retry")}
          </button>
        </p>
      ) : null}
      {reports.isSuccess && shown.length === 0 ? (
        // Nothing matches: the line alone, no header row over an empty table.
        <p className="alert-card alert-pad alert-muted report-none">{t("reports.noMatch")}</p>
      ) : null}
      {reports.isSuccess && shown.length > 0 ? (
        <div className="alert-card alert-table-wrap report-list">
          <table className="alert-table report-table" {...STACK_ROLES.table}>
            <thead {...STACK_ROLES.rowgroup}>
              <tr {...STACK_ROLES.row}>
                <th scope="col" {...STACK_ROLES.columnheader}>
                  {t("reports.col.report")}
                </th>
                <th scope="col" {...STACK_ROLES.columnheader}>
                  {t("reports.col.schedule")}
                </th>
                <th scope="col" className="report-table__fold" {...STACK_ROLES.columnheader}>
                  {t("reports.col.format")}
                </th>
                <th scope="col" {...STACK_ROLES.columnheader}>
                  {t("reports.col.recipients")}
                </th>
                <th scope="col" {...STACK_ROLES.columnheader}>
                  {t("reports.col.next")}
                </th>
                <th scope="col" {...STACK_ROLES.columnheader}>
                  {t("reports.col.last")}
                </th>
                <th scope="col" className="report-table__fold" {...STACK_ROLES.columnheader}>
                  {t("reports.col.owner")}
                </th>
                {/* Named by its label: a hidden span in the cell would lie outside the table's
                    scroll box and widen the page. */}
                <th
                  scope="col"
                  aria-label={t("reports.col.actions")}
                  {...STACK_ROLES.columnheader}
                />
              </tr>
            </thead>
            <tbody {...STACK_ROLES.rowgroup}>
              {shown.map((report) => {
                const quiet = report.paused || report.suspended !== null;
                return (
                  <tr
                    key={report.id}
                    className={quiet ? "report-row--quiet" : undefined}
                    {...STACK_ROLES.row}
                  >
                    <td className="report-table__name" {...STACK_ROLES.cell}>
                      <Link
                        to="/reports/$reportId"
                        params={{ reportId: report.id }}
                        className="alert-rule-name"
                      >
                        {report.name}
                      </Link>
                      <ReportContent report={report} />
                    </td>
                    <td
                      className={report.schedule.kind === "cron" ? "alert-mono-cell" : undefined}
                      data-label={t("reports.col.schedule")}
                      {...STACK_ROLES.cell}
                    >
                      {scheduleText(t, language, report.schedule)}
                    </td>
                    <td
                      className="report-table__fold"
                      data-label={t("reports.col.format")}
                      {...STACK_ROLES.cell}
                    >
                      {formatsText(report.formats)}
                    </td>
                    <td
                      className="alert-num-left"
                      data-label={t("reports.col.recipients")}
                      {...STACK_ROLES.cell}
                    >
                      {recipientsText(t, report.recipients)}
                    </td>
                    <td
                      className="alert-num-left"
                      data-label={t("reports.col.next")}
                      {...STACK_ROLES.cell}
                    >
                      {report.nextRunAt === null || quiet ? "–" : time.dayTime(report.nextRunAt)}
                    </td>
                    <td data-label={t("reports.col.last")} {...STACK_ROLES.cell}>
                      <LastRun report={report} day={time.day} />
                    </td>
                    <td
                      className="report-table__fold"
                      data-label={t("reports.col.owner")}
                      {...STACK_ROLES.cell}
                    >
                      {report.ownerName ?? t("reports.ownerGone")}
                    </td>
                    <td className="report-table__menu" {...STACK_ROLES.cell}>
                      <ReportMenu
                        report={report}
                        canWrite={canWrite}
                        owns={manages(report)}
                        sendBlocked={sendBlocked}
                        full={full}
                        onPause={(paused) => pause.mutate({ report, paused })}
                        onSend={() => setSending(report)}
                        onDelete={() => setDeleting(report)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {suspended.map((report) => (
        <p key={report.id} className="alert-note report-suspended">
          <Icon name="info" />
          <span>
            <strong>{t("reports.suspended.name", { name: report.name })}</strong>{" "}
            {report.suspended === null ? null : codeText(t, report.suspended)}{" "}
            {t("reports.suspended.hint")}
          </span>
          {canWrite && !full ? (
            <Link
              to="/reports/new"
              search={{ copy: report.id }}
              className="button button--secondary button--small"
            >
              {t("reports.menu.copy")}
            </Link>
          ) : null}
        </p>
      ))}
      <ConfirmDialog
        open={deleting !== null}
        title={t("reports.delete.title", { name: deleting?.name ?? "" })}
        confirmLabel={t("admin.common.delete")}
        busy={remove.isPending}
        error={remove.isError ? reportErrorText(t, remove.error) : null}
        onConfirm={() => deleting !== null && remove.mutate(deleting)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      >
        <p>{t("reports.delete.text")}</p>
      </ConfirmDialog>
      <SendDialog
        report={sending}
        busy={send.isPending}
        error={send.isError ? reportErrorText(t, send.error) : null}
        onConfirm={() => sending !== null && send.mutate(sending)}
        onClose={() => {
          setSending(null);
          send.reset();
        }}
      />
    </ReportsFrame>
  );
}

/**
 * Asks before a report goes out now: it reaches every recipient, not only the person asking.
 * Focus starts on Cancel, so Enter does not send.
 */
export function SendDialog({
  report,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  report: Report | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  return (
    <Dialog
      open={report !== null}
      title={t("reports.send.title", { name: report?.name ?? "" })}
      onClose={onClose}
      initialFocus={cancelRef}
      describedBy={textId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={busy || undefined}
            onClick={() => !busy && onConfirm()}
          >
            {t("reports.menu.send")}
          </button>
        </>
      }
    >
      <p id={textId}>
        {t("reports.send.text", { count: report?.recipients.filter(reachable).length ?? 0 })}
      </p>
      {error === null ? null : (
        <p className="field__error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </Dialog>
  );
}

/**
 * What a report sends, as one line under its name, and below it the format and creator for the
 * widths without those columns; each cut where the column ends, whole in its title.
 */
function ReportContent({ report }: { report: Report }) {
  const { t } = useI18n();
  const text =
    report.panelIds === null
      ? t("reports.content.all", { dashboard: report.dashboardTitle })
      : t("reports.content.panels", {
          dashboard: report.dashboardTitle,
          count: report.panelIds.length,
        });
  const formats = formatsText(report.formats);
  const by =
    report.ownerName === null
      ? t("reports.content.byNobody", { formats })
      : t("reports.content.by", { formats, owner: report.ownerName });
  return (
    <>
      <CutText className="alert-sub" text={text} />
      {/* Shown instead of the format and creator columns where they have no room. */}
      <CutText className="alert-sub report-table__folded" text={by} />
    </>
  );
}

/** The last run as a word with its day; suspended and paused come first, since nothing runs. */
function LastRun({ report, day }: { report: Report; day: (ms: number) => string }) {
  if (report.suspended !== null) return <StateLabel state="suspended" />;
  if (report.paused) return <StateLabel state="paused" />;
  const run = report.lastRun;
  if (run === null) return <span className="alert-muted">–</span>;
  return (
    <span className="report-last">
      <StateLabel state={run.status} quiet={run.status === "ok"} />
      <span className="alert-muted">{day(run.finishedAt ?? run.createdAt)}</span>
    </span>
  );
}

function ReportMenu({
  report,
  canWrite,
  owns,
  sendBlocked,
  full,
  onPause,
  onSend,
  onDelete,
}: {
  report: Report;
  canWrite: boolean;
  /** The person created the report or is an organization admin: may change, send and delete it. */
  owns: boolean;
  sendBlocked: boolean;
  /** The organization has as many reports as it may: no copy; the note over the list says why. */
  full: boolean;
  onPause: (paused: boolean) => void;
  onSend: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const open = () => void navigate({ to: "/reports/$reportId", params: { reportId: report.id } });
  const entries: ToolbarMenuEntry[] = [
    owns
      ? { key: "edit", label: t("reports.menu.edit"), icon: "edit", onSelect: open }
      : { key: "open", label: t("reports.menu.open"), icon: "eye", onSelect: open },
    {
      key: "runs",
      label: t("reports.tab.runs"),
      icon: "history",
      onSelect: () =>
        void navigate({ to: "/reports/$reportId/runs", params: { reportId: report.id } }),
    },
  ];
  // Anyone who writes reports may stop one; starting, sending and deleting are its creator's.
  if (canWrite && (owns || !report.paused)) {
    entries.push({
      key: "pause",
      label: t(report.paused ? "reports.menu.resume" : "reports.menu.pause"),
      onSelect: () => onPause(!report.paused),
    });
  }
  if (owns) {
    entries.push({
      key: "send",
      label: t("reports.menu.send"),
      disabled: sendBlocked,
      onSelect: onSend,
    });
  }
  if (canWrite) {
    entries.push({
      key: "copy",
      label: t("reports.menu.copy"),
      icon: "copy",
      disabled: full,
      onSelect: () => void navigate({ to: "/reports/new", search: { copy: report.id } }),
    });
  }
  entries.push({
    key: "dashboard",
    label: t("reports.menu.dashboard"),
    icon: "dashboards",
    onSelect: () =>
      void navigate({
        to: "/dashboards/$dashboardId",
        params: { dashboardId: report.dashboardId },
        search: {},
      }),
  });
  if (owns) {
    entries.push(
      { kind: "separator", key: "sep" },
      {
        key: "delete",
        label: t("admin.common.delete"),
        icon: "trash",
        danger: true,
        onSelect: onDelete,
      },
    );
  }
  return (
    <ToolbarMenu
      label={t("reports.menu.label", { name: report.name })}
      icon="more"
      entries={entries}
    />
  );
}
