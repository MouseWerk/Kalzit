import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { Breadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { type OrgPermissions, useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { type ReportsStatus, type RunStatus, statusQuery } from "./api";
// Lists, steps and states look as in alerting; reports.css adds what only reports have.
import "../alerting/alerting.css";
import "./reports.css";

export interface ReportsContext {
  orgId: string;
  orgName: string;
  permissions: OrgPermissions;
  status: ReportsStatus | undefined;
  canWrite: boolean;
}

/** The organization, the person's rights on reports and the status every page reads. */
export function useReports(): ReportsContext {
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const permissions = useOrgPermissions();
  const status = useQuery({
    ...statusQuery(orgId),
    enabled: org !== undefined && permissions.has("reports:read"),
  });
  return {
    orgId,
    orgName: org?.name ?? "",
    permissions,
    status: status.data,
    canWrite: permissions.has("reports:write"),
  };
}

export type ReportState = RunStatus | "paused";

const STATE_KEYS: Record<ReportState, MessageKey> = {
  queued: "reports.state.queued",
  running: "reports.state.running",
  ok: "reports.state.ok",
  partial: "reports.state.partial",
  failed: "reports.state.failed",
  suspended: "reports.state.suspended",
  skipped: "reports.state.skipped",
  paused: "reports.state.paused",
};

/** The tint next to the word, in alerting's vocabulary: failed in danger, the waiting ones in warning. */
const STATE_TINT: Record<ReportState, string> = {
  queued: "pending",
  running: "pending",
  ok: "ok",
  partial: "error",
  failed: "firing",
  suspended: "error",
  skipped: "no_data",
  paused: "paused",
};

/** A state as a word with a dot; the color is only a hint next to the word. */
export function StateLabel({ state, quiet = false }: { state: ReportState; quiet?: boolean }) {
  const { t } = useI18n();
  return (
    <span
      className={quiet ? "alert-state alert-state--quiet" : "alert-state"}
      data-state={STATE_TINT[state]}
    >
      <span className="alert-state__dot" aria-hidden="true" />
      {t(STATE_KEYS[state])}
    </span>
  );
}

/** Times as the board writes them: "Mo 16.11., 07:00", in the person's zone or the given one. */
export function useReportTime(zone?: string): {
  dayTime: (ms: number) => string;
  day: (ms: number) => string;
  clock: (ms: number) => string;
} {
  const { language, timeZone } = useI18n();
  const option = zoneOption(zone ?? timeZone);
  const dayTime = new Intl.DateTimeFormat(language, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...option,
  });
  const day = new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit", ...option });
  const clock = new Intl.DateTimeFormat(language, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...option,
  });
  return {
    dayTime: (ms) => dayTime.format(ms),
    day: (ms) => day.format(ms),
    clock: (ms) => clock.format(ms),
  };
}

/**
 * The frame of the report pages (board Reports.dc.html, frames 1, 2, 5 and 9): heading, trail and
 * actions, and what stands in the way of every report: no right to see them, reports turned off,
 * no mail server.
 */
export function ReportsFrame({
  title,
  lead,
  crumbs,
  actions,
  children,
}: {
  title: string;
  lead?: string;
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { permissions, status } = useReports();
  if (permissions.loaded && !permissions.has("reports:read")) {
    return (
      <Page title={t("reports.title")}>
        <Breadcrumbs crumbs={[{ label: t("reports.title") }]} />
        <EmptyState icon="lock" title={t("reports.forbidden.title")}>
          {t("errors.forbidden")}
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page title={title} {...(lead === undefined ? {} : { lead })}>
      <Breadcrumbs crumbs={crumbs} />
      {actions}
      {status !== undefined && !status.enabled ? (
        <p className="alert-note" role="status">
          <Icon name="info" />
          {t("reports.reason.disabled")}
        </p>
      ) : null}
      {status?.enabled === true && !status.mailConfigured ? <NoMail /> : null}
      {children}
    </Page>
  );
}

/** Without a mail server nothing is sent; server admins get the way to set one up. */
function NoMail() {
  const { t } = useI18n();
  const { permissions } = useReports();
  return (
    <section className="alert-card report-banner" aria-labelledby="report-no-mail">
      <Icon name="info" />
      <div>
        <h2 id="report-no-mail" className="report-banner__title">
          {t("reports.noMail.title")}
        </h2>
        <p className="alert-muted">{t("reports.noMail.text")}</p>
      </div>
      {permissions.isServerAdmin ? (
        <Link
          to="/settings/$section"
          params={{ section: "email" }}
          className="button button--secondary button--small"
        >
          {t("reports.noMail.link")}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * A small set of buttons for one choice, as a radio group: the choice applies at once, arrow
 * keys move between the options, Tab reaches only the chosen one.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; disabled?: boolean; title?: string }[];
  onChange: (value: Value) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  function move(from: number, step: number) {
    for (let n = 1; n <= options.length; n += 1) {
      const next = (from + step * n + options.length * n) % options.length;
      const option = options[next];
      if (option !== undefined && option.disabled !== true) {
        refs.current[next]?.focus();
        onChange(option.value);
        return;
      }
    }
  }
  return (
    <div className="alert-seg" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        // biome-ignore lint/a11y/useSemanticElements: radio buttons as buttons, so a choice applies at once
        <button
          key={option.value}
          ref={(element) => {
            refs.current[i] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-disabled={option.disabled === true || undefined}
          title={option.title}
          tabIndex={i === index ? 0 : -1}
          className="alert-seg__item"
          onClick={() => option.disabled !== true && onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(i, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(i, -1);
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** The pages of one report as links: its settings and its runs. */
export function ReportTabs({ reportId }: { reportId: string }) {
  const { t } = useI18n();
  return (
    <nav className="alert-tabs tabs" aria-label={t("reports.tabs")}>
      <Link
        to="/reports/$reportId"
        params={{ reportId }}
        className="tabs__tab"
        activeOptions={{ exact: true, includeSearch: false }}
      >
        {t("reports.tab.settings")}
      </Link>
      <Link
        to="/reports/$reportId/runs"
        params={{ reportId }}
        className="tabs__tab"
        activeOptions={{ exact: true, includeSearch: false }}
      >
        {t("reports.tab.runs")}
      </Link>
    </nav>
  );
}
