import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import type { Frame } from "../../api/generated/shapes";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { timeseriesPanel } from "../../panels/timeseries";
import { adminKeys, listOrgs, MAX_PAGE_SIZE } from "../admin/api";
import { formatDateTime } from "../admin/components/format";
import { usePagedList } from "../admin/components/lists";
import { PagedSelect } from "../admin/components/PagedSelect";
import { LoadState, Section } from "../admin/components/Section";
import { allowedWhen, useAdminAccess } from "../admin/sections";
import { Segmented } from "../settings/rows";
import {
  type DashboardUsage,
  errorRate,
  fetchUnused,
  fetchUsage,
  hitRate,
  type PanelUsage,
  type SourceUsage,
  type UsageReport,
  type UsageScope,
  usageKeys,
} from "./api";
import "./usage.css";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The periods to choose from, in days. */
export const PERIODS = [1, 7, 30, 90] as const;
/** "No views in" 30 or 90 days. */
export const UNUSED_PERIODS = [30, 90] as const;

/**
 * Verwaltung > Nutzung: how often dashboards are opened and how often, how slowly and how
 * reliably panels and data sources answer (docs/api/usage.md). Counts per dashboard, panel and
 * data source only; the page says so. Organization admins (`audit:read`) see their organization;
 * server administrators choose one or all.
 */
export function UsagePage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const allowed = access.isServerAdmin || access.has("audit:read");
  const orgFilterId = useId();
  // Server administrators start with the current organization, or all without one.
  const [orgChoice, setOrgChoice] = useState<string | undefined>(undefined);
  const orgs = usePagedList(
    [...adminKeys.orgs, "picker"],
    (cursor) => listOrgs(cursor, MAX_PAGE_SIZE),
    access.isServerAdmin,
  );
  const serverOrg = orgChoice ?? access.orgId ?? "";
  const scope: UsageScope | undefined = access.isServerAdmin
    ? { kind: "server", ...(serverOrg === "" ? {} : { orgId: serverOrg }) }
    : access.orgId === undefined
      ? undefined
      : { kind: "org", orgId: access.orgId };
  return (
    <Section
      title="usage.title"
      lead="usage.lead"
      allowed={allowedWhen(access, allowed)}
      actions={
        access.isServerAdmin ? (
          <div className="field usage-org">
            <label className="field__label" htmlFor={orgFilterId}>
              {t("usage.org")}
            </label>
            <PagedSelect
              id={orgFilterId}
              value={serverOrg}
              onChange={setOrgChoice}
              anyLabel={t("usage.allOrgs")}
              {...orgs.picker((org) => ({ id: org.id, label: org.name }))}
            />
          </div>
        ) : undefined
      }
    >
      {allowed && scope !== undefined ? (
        <UsageView
          scope={scope}
          currentOrgId={access.orgId}
          showOrg={scope.orgId === undefined}
          canChangeSettings={access.isServerAdmin}
        />
      ) : null}
    </Section>
  );
}

function UsageView({
  scope,
  currentOrgId,
  showOrg,
  canChangeSettings,
}: {
  scope: UsageScope;
  /** Rows of this organization link to their dashboard, panel or source. */
  currentOrgId: string | undefined;
  /** Every organization: rows name theirs. */
  showOrg: boolean;
  /** Server administrators may turn recording on; only they get the link to its setting. */
  canChangeSettings: boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const periodId = useId();
  const [days, setDays] = useState<number>(7);
  const report = useQuery({
    queryKey: usageKeys.report(scope, days),
    queryFn: ({ signal }) => {
      const to = Date.now();
      return fetchUsage(scope, { from: to - days * DAY_MS, to }, signal);
    },
    placeholderData: keepPreviousData,
  });
  const format = useFormats();
  const data = report.data;
  return (
    <div className="usage">
      <p className="notice usage-privacy">{t("usage.privacy")}</p>
      <div className="usage-toolbar">
        <span className="usage-toolbar__label" id={periodId}>
          {t("usage.period")}
        </span>
        <Segmented
          labelled={{ "aria-labelledby": periodId }}
          value={String(days)}
          options={PERIODS.map((value) => ({
            value: String(value),
            label: value === 1 ? t("usage.period.day") : t("usage.period.days", { days: value }),
          }))}
          onChange={(value) => setDays(Number(value))}
        />
      </div>
      {data === undefined ? (
        <LoadState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <>
          {data.recording ? null : (
            <div className="notice" role="status">
              <span>{t("usage.recordingOff")}</span>
              {canChangeSettings ? (
                <>
                  {" "}
                  <Link to="/settings/$section" params={{ section: "storage" }}>
                    {t("usage.recordingSettings")}
                  </Link>
                </>
              ) : null}
            </div>
          )}
          {data.since !== null && data.since > data.from ? (
            <p className="usage-muted">
              {t("usage.since", { date: formatDateTime(data.since, language, timeZone) })}
            </p>
          ) : null}
          <Tiles report={data} />
          <TrendCard report={data} />
          <Card title="usage.dashboards.title" lead="usage.dashboards.lead">
            <DashboardsTable
              rows={data.dashboards}
              currentOrgId={currentOrgId}
              showOrg={showOrg}
              format={format}
            />
          </Card>
          <Card title="usage.slowPanels.title" lead="usage.slowPanels.lead">
            <PanelsTable
              rows={data.slowPanels}
              kind="slow"
              currentOrgId={currentOrgId}
              showOrg={showOrg}
              format={format}
            />
          </Card>
          <Card title="usage.failingPanels.title" lead="usage.failingPanels.lead">
            <PanelsTable
              rows={data.failingPanels}
              kind="failing"
              currentOrgId={currentOrgId}
              showOrg={showOrg}
              format={format}
            />
          </Card>
          <Card title="usage.sources.title" lead="usage.sources.lead">
            <SourcesTable
              rows={data.sources}
              currentOrgId={currentOrgId}
              showOrg={showOrg}
              format={format}
            />
          </Card>
        </>
      )}
      <UnusedCard scope={scope} currentOrgId={currentOrgId} showOrg={showOrg} format={format} />
      {data !== undefined && data.dropped > 0 ? (
        <p className="usage-muted">{t("usage.dropped", { count: format.number(data.dropped) })}</p>
      ) : null}
    </div>
  );
}

interface Formats {
  number: (value: number) => string;
  percent: (share: number | null) => string;
  duration: (ms: number | null) => string;
  date: (ms: number) => string;
}

function useFormats(): Formats {
  const { t, language, timeZone } = useI18n();
  const number = new Intl.NumberFormat(language);
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const seconds = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  return {
    number: (value) => number.format(value),
    percent: (share) => (share === null ? t("usage.none") : percent.format(share)),
    duration: (ms) =>
      ms === null
        ? t("usage.none")
        : ms < 1000
          ? t("usage.ms", { value: number.format(ms) })
          : t("usage.s", { value: seconds.format(ms / 1000) }),
    date: (ms) => formatDateTime(ms, language, timeZone),
  };
}

function Card({
  title,
  lead,
  actions,
  children,
}: {
  title: MessageKey;
  lead: MessageKey;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <section className="usage-card" aria-labelledby={titleId}>
      <div className="usage-card__head">
        <div className="usage-card__title">
          <h2 id={titleId}>{t(title)}</h2>
          <p className="usage-muted">{t(lead)}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Tiles({ report }: { report: UsageReport }) {
  const { t } = useI18n();
  const format = useFormats();
  const { totals } = report;
  const tiles: { label: MessageKey; value: string }[] = [
    { label: "usage.totals.views", value: format.number(totals.views) },
    { label: "usage.totals.panelRuns", value: format.number(totals.panelRuns) },
    { label: "usage.totals.queries", value: format.number(totals.queries) },
    {
      label: "usage.totals.errorRate",
      value: format.percent(errorRate(totals.queryErrors, totals.queries)),
    },
    {
      label: "usage.totals.hitRate",
      value: format.percent(hitRate(totals.cacheHits, totals.cacheMisses)),
    },
  ];
  return (
    <ul className="usage-tiles" aria-label={t("usage.totals.title")}>
      {tiles.map((tile) => (
        <li key={tile.label} className="usage-tile">
          <span className="usage-tile__label">{t(tile.label)}</span>
          <span className="usage-tile__value">{tile.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The trend as Kalzit's own time series panel: one series per count. */
export function trendFrame(report: UsageReport, t: Translate): Frame {
  return {
    fields: [
      { name: t("usage.trend.time"), type: "time", values: report.trend.map((p) => p.at) },
      {
        name: t("usage.totals.views"),
        type: "number",
        values: report.trend.map((p) => p.views),
      },
      {
        name: t("usage.totals.panelRuns"),
        type: "number",
        values: report.trend.map((p) => p.panelRuns),
      },
      {
        name: t("usage.totals.queries"),
        type: "number",
        values: report.trend.map((p) => p.queries),
      },
      {
        name: t("usage.trend.errors"),
        type: "number",
        values: report.trend.map((p) => p.panelErrors + p.queryErrors),
      },
    ],
  };
}

function TrendCard({ report }: { report: UsageReport }) {
  const { t } = useI18n();
  const Panel = timeseriesPanel.Panel;
  return (
    <Card
      title="usage.trend.title"
      lead={report.stepMs < DAY_MS ? "usage.trend.hourly" : "usage.trend.daily"}
    >
      <div className="usage-chart">
        <Panel
          frames={[trendFrame(report, t)]}
          options={timeseriesPanel.options(undefined)}
          timeRange={{ from: report.from, to: report.to }}
          title={t("usage.trend.title")}
        />
      </div>
    </Card>
  );
}

function OrgCell({ name, show }: { name: string; show: boolean }) {
  return show ? <td>{name}</td> : null;
}

function DashboardLink({
  orgId,
  currentOrgId,
  dashboardId,
  panelId,
  children,
}: {
  orgId: string;
  currentOrgId: string | undefined;
  dashboardId: string;
  panelId?: string;
  children: string;
}) {
  // Another organization's dashboards open in that organization only.
  if (orgId !== currentOrgId) {
    return <span>{children}</span>;
  }
  return (
    <Link
      to="/dashboards/$dashboardId"
      params={{ dashboardId }}
      search={panelId === undefined ? {} : { viewPanel: panelId }}
    >
      {children}
    </Link>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="usage-card__body usage-muted">{text}</p>;
}

function DashboardsTable({
  rows,
  currentOrgId,
  showOrg,
  format,
}: {
  rows: DashboardUsage[];
  currentOrgId: string | undefined;
  showOrg: boolean;
  format: Formats;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <Empty text={t("usage.dashboards.none")} />;
  }
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{t("usage.col.dashboard")}</th>
            {showOrg ? <th scope="col">{t("usage.col.org")}</th> : null}
            <th scope="col" className="usage-table__number">
              {t("usage.col.views")}
            </th>
            <th scope="col">{t("usage.col.lastViewed")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.orgId}/${row.id}`}>
              <th scope="row" className="usage-table__name">
                <DashboardLink orgId={row.orgId} currentOrgId={currentOrgId} dashboardId={row.id}>
                  {row.title}
                </DashboardLink>
              </th>
              <OrgCell name={row.orgName} show={showOrg} />
              <td className="usage-table__number">{format.number(row.views)}</td>
              <td className="usage-muted">{format.date(row.lastViewedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PanelsTable({
  rows,
  kind,
  currentOrgId,
  showOrg,
  format,
}: {
  rows: PanelUsage[];
  kind: "slow" | "failing";
  currentOrgId: string | undefined;
  showOrg: boolean;
  format: Formats;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return (
      <Empty text={kind === "slow" ? t("usage.slowPanels.none") : t("usage.failingPanels.none")} />
    );
  }
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{t("usage.col.panel")}</th>
            <th scope="col">{t("usage.col.dashboard")}</th>
            {showOrg ? <th scope="col">{t("usage.col.org")}</th> : null}
            <th scope="col" className="usage-table__number">
              {t("usage.col.runs")}
            </th>
            {kind === "slow" ? (
              <>
                <th scope="col" className="usage-table__number">
                  {t("usage.col.p50")}
                </th>
                <th scope="col" className="usage-table__number">
                  {t("usage.col.p95")}
                </th>
              </>
            ) : (
              <>
                <th scope="col" className="usage-table__number">
                  {t("usage.col.errors")}
                </th>
                <th scope="col" className="usage-table__number">
                  {t("usage.col.errorRate")}
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.orgId}/${row.dashboardId}/${row.panelId}`}>
              <th scope="row" className="usage-table__name">
                <DashboardLink
                  orgId={row.orgId}
                  currentOrgId={currentOrgId}
                  dashboardId={row.dashboardId}
                  panelId={row.panelId}
                >
                  {row.panelTitle === "" ? t("usage.untitledPanel") : row.panelTitle}
                </DashboardLink>
              </th>
              <td className="usage-muted">{row.dashboardTitle}</td>
              <OrgCell name={row.orgName} show={showOrg} />
              <td className="usage-table__number">{format.number(row.runs)}</td>
              {kind === "slow" ? (
                <>
                  <td className="usage-table__number">{format.duration(row.p50Ms)}</td>
                  <td className="usage-table__number">{format.duration(row.p95Ms)}</td>
                </>
              ) : (
                <>
                  <td className="usage-table__number">{format.number(row.errors)}</td>
                  <td className="usage-table__number">
                    {format.percent(errorRate(row.errors, row.runs))}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The error classes of a source as one line: "2 timeouts, 1 refused". */
function errorClasses(row: SourceUsage, t: Translate, format: Formats): string {
  const parts: string[] = [];
  const add = (count: number, key: MessageKey) => {
    if (count > 0) {
      parts.push(t(key, { count: format.number(count) }));
    }
  };
  add(row.errorsTimeout, "usage.errors.timeout");
  add(row.errorsRejected, "usage.errors.rejected");
  add(row.errorsSource, "usage.errors.source");
  add(row.errorsOther, "usage.errors.other");
  return parts.join(", ");
}

function SourcesTable({
  rows,
  currentOrgId,
  showOrg,
  format,
}: {
  rows: SourceUsage[];
  currentOrgId: string | undefined;
  showOrg: boolean;
  format: Formats;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <Empty text={t("usage.sources.none")} />;
  }
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr>
            <th scope="col">{t("usage.col.source")}</th>
            {showOrg ? <th scope="col">{t("usage.col.org")}</th> : null}
            <th scope="col" className="usage-table__number">
              {t("usage.col.queries")}
            </th>
            <th scope="col" className="usage-table__number">
              {t("usage.col.errors")}
            </th>
            <th scope="col" className="usage-table__number">
              {t("usage.col.p50")}
            </th>
            <th scope="col" className="usage-table__number">
              {t("usage.col.p95")}
            </th>
            <th scope="col" className="usage-table__number">
              {t("usage.col.hitRate")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const classes = errorClasses(row, t, format);
            return (
              <tr key={`${row.orgId}/${row.id}`}>
                <th scope="row" className="usage-table__name">
                  {row.orgId === currentOrgId ? (
                    <Link to="/data-sources/$datasourceId" params={{ datasourceId: row.id }}>
                      {row.name}
                    </Link>
                  ) : (
                    <span>{row.name}</span>
                  )}
                </th>
                <OrgCell name={row.orgName} show={showOrg} />
                <td className="usage-table__number">{format.number(row.queries)}</td>
                <td className="usage-table__number">
                  <span>
                    {format.number(row.errors)} (
                    {format.percent(errorRate(row.errors, row.queries))})
                  </span>
                  {classes === "" ? null : <span className="usage-table__detail">{classes}</span>}
                </td>
                <td className="usage-table__number">{format.duration(row.p50Ms)}</td>
                <td className="usage-table__number">{format.duration(row.p95Ms)}</td>
                <td className="usage-table__number">
                  {format.percent(hitRate(row.cacheHits, row.cacheMisses))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnusedCard({
  scope,
  currentOrgId,
  showOrg,
  format,
}: {
  scope: UsageScope;
  currentOrgId: string | undefined;
  showOrg: boolean;
  format: Formats;
}) {
  const { t } = useI18n();
  const periodId = useId();
  const [days, setDays] = useState<number>(30);
  const unused = useQuery({
    queryKey: usageKeys.unused(scope, days),
    queryFn: ({ signal }) => fetchUnused(scope, days, signal),
    placeholderData: keepPreviousData,
  });
  const data = unused.data;
  return (
    <Card
      title="usage.unused.title"
      lead="usage.unused.lead"
      actions={
        <>
          <span className="visually-hidden" id={periodId}>
            {t("usage.unused.period")}
          </span>
          <Segmented
            labelled={{ "aria-labelledby": periodId }}
            value={String(days)}
            options={UNUSED_PERIODS.map((value) => ({
              value: String(value),
              label: t("usage.unused.days", { days: value }),
            }))}
            onChange={(value) => setDays(Number(value))}
          />
        </>
      }
    >
      {data === undefined ? (
        <div className="usage-card__body">
          <LoadState error={unused.error} onRetry={() => void unused.refetch()} />
        </div>
      ) : data.items.length === 0 ? (
        <Empty text={t("usage.unused.none", { days: data.days })} />
      ) : (
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption className="usage-table__caption">
              {data.recordedSince === null || data.recordedSince <= data.since
                ? t("usage.unused.count", {
                    shown: format.number(data.items.length),
                    total: format.number(data.total),
                  })
                : t("usage.unused.countSince", {
                    shown: format.number(data.items.length),
                    total: format.number(data.total),
                    date: format.date(data.recordedSince),
                  })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("usage.col.dashboard")}</th>
                {showOrg ? <th scope="col">{t("usage.col.org")}</th> : null}
                <th scope="col">{t("usage.col.lastViewed")}</th>
                <th scope="col">{t("usage.col.created")}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={`${row.orgId}/${row.id}`}>
                  <th scope="row" className="usage-table__name">
                    <DashboardLink
                      orgId={row.orgId}
                      currentOrgId={currentOrgId}
                      dashboardId={row.id}
                    >
                      {row.title}
                    </DashboardLink>
                  </th>
                  <OrgCell name={row.orgName} show={showOrg} />
                  <td className="usage-muted">
                    {row.lastViewedAt === null
                      ? t("usage.unused.never")
                      : format.date(row.lastViewedAt)}
                  </td>
                  <td className="usage-muted">{format.date(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
