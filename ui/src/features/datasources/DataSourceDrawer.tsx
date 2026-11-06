import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { Shape } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { tabForKey } from "../../lib/tabKeys";
import { zoneOption } from "../../lib/timeSettings";
import { useOrgPermissions } from "../../org/useOrg";
import { AccessDialog } from "../admin/access";
import { adminKeys, type Grant, listGrants, type SubjectType } from "../admin/api";
import { LEVEL_TEXT, roleLabel, SUBJECT_TEXT } from "../admin/catalog";
import { usePagedList } from "../admin/components/lists";
import { mayManageAccess } from "../dashboards/accessIntegration";
import { errorMessage } from "../dashboards/ui/errors";
import { openWithSource } from "../explore/lastSource";
import {
  type DatasourceAccess,
  type DatasourceSummary,
  sourceHistoryQuery,
  sourceUsageQuery,
} from "./api";
import { HealthResult } from "./DataSourceForm";
import { KindMark } from "./kindMarks";
import { initials, Sparkline, useAgo } from "./listCells";
import { StatusLabel } from "./StatusLabel";
import { type HealthEntry, median, type SourceStatus } from "./sourceStatus";
import { TeamAccess } from "./TeamAccess";
import "./datasources.css";

export { initials };

const TABS = ["overview", "access", "usage", "history"] as const;
export type DrawerTab = (typeof TABS)[number];

export const SHAPE_TEXT: Record<Shape, MessageKey> = {
  frame: "datasources.shape.frame",
  documents: "datasources.shape.documents",
  graph: "datasources.shape.graph",
};

/** People first, then roles: teams have their own section above. */
const SUBJECT_ORDER: readonly SubjectType[] = ["team", "user", "role"];

/** The audit actions a source's history names in words; others show as "Changed". */
const HISTORY_TEXT: Record<string, MessageKey> = {
  "datasource.created": "datasources.history.created",
  "datasource.updated": "datasources.history.updated",
  "datasource.deleted": "datasources.history.deleted",
  "datasource.restored": "datasources.history.restored",
  "datasource.ai_access_changed": "datasources.history.aiAccess",
  "grant.created": "datasources.history.grantCreated",
  "grant.changed": "datasources.history.grantChanged",
  "grant.deleted": "datasources.history.grantDeleted",
};

/**
 * The side panel of the selected source: its status, the actions on it, and tabs for the
 * overview, who has access (teams changed in place, with undo), where it is used and what
 * happened to it. The panel only shows what the caller may see; the server checks every request.
 */
export function DataSourceDrawer({
  orgId,
  source,
  kindName,
  shapes,
  added,
  access,
  entry,
  status,
  latencyMs,
  initialTab = "overview",
  onTest,
  onClose,
}: {
  orgId: string;
  source: DatasourceSummary;
  kindName: string;
  shapes: readonly Shape[];
  added: string;
  access: DatasourceAccess;
  entry: HealthEntry | undefined;
  /** The status the list shows: a test of this session, else the stored one. */
  status: SourceStatus;
  latencyMs: number | undefined;
  initialTab?: DrawerTab | undefined;
  onTest: () => void;
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const permissions = useOrgPermissions();
  const timeFormat = new Intl.DateTimeFormat(language, {
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const titleId = useId();
  const tabsId = useId();
  const canManage = mayManageAccess("datasource", access.permissions, permissions);
  const tabs = TABS.filter(
    (name) =>
      name === "overview" ||
      (name === "access" && canManage) ||
      ((name === "usage" || name === "history") && access.read),
  );
  const [chosen, setChosen] = useState<DrawerTab>(initialTab);
  const tab: DrawerTab = tabs.includes(chosen) ? chosen : "overview";

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(tabs, tab, event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setChosen(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }

  let body = null;
  if (tab === "access") {
    body = <AccessSection orgId={orgId} source={source} />;
  } else if (tab === "usage") {
    body = <UsageSection orgId={orgId} source={source} />;
  } else if (tab === "history") {
    body = <HistorySection orgId={orgId} source={source} />;
  } else {
    body = (
      <>
        <dl className="ds-facts">
          <div>
            <dt>{t("datasources.column.kind")}</dt>
            <dd>{kindName}</dd>
          </div>
          {source.details?.address === undefined ? null : (
            <div>
              <dt>{t("datasources.drawer.address")}</dt>
              <dd className="ds-facts__mono">{source.details.address}</dd>
            </div>
          )}
          <div>
            <dt>{t("datasources.drawer.shapes")}</dt>
            <dd>{shapes.map((shape) => t(SHAPE_TEXT[shape])).join(", ")}</dd>
          </div>
          <div>
            <dt>{t("datasources.column.created")}</dt>
            <dd>{added}</dd>
          </div>
          <div>
            <dt>{t("datasources.drawer.yourAccess")}</dt>
            <dd>{t(yourAccess(access))}</dd>
          </div>
          {entry !== undefined && entry.at > 0 && !entry.pending ? (
            <div>
              <dt>{t("datasources.drawer.testedAt")}</dt>
              <dd>
                {t("datasources.drawer.testedAtValue", { time: timeFormat.format(entry.at) })}
              </dd>
            </div>
          ) : null}
        </dl>
        {access.query ? (
          <HealthResult health={entry?.health ?? null} error={entry?.error ?? null} />
        ) : null}
      </>
    );
  }

  return (
    <aside className="ds-drawer" aria-labelledby={titleId}>
      <div className="ds-drawer__head">
        <KindMark kind={source.kind} />
        <div className="ds-drawer__title">
          <h2 id={titleId} tabIndex={-1}>
            {source.name}
          </h2>
          {source.details?.address === undefined ? null : (
            <span className="ds-table__address">{source.details.address}</span>
          )}
          <span className="ds-drawer__meta">
            <StatusLabel status={status} latencyMs={latencyMs} />
            <span aria-hidden="true">·</span>
            <span>{kindName}</span>
          </span>
        </div>
        <IconButton
          icon="close"
          label={t("datasources.drawer.close")}
          className="ds-drawer__close"
          onClick={onClose}
        />
      </div>
      <div className="ds-drawer__actions">
        {access.query ? (
          <Link
            to="/explore"
            className="button button--secondary button--small"
            onClick={() => openWithSource(source.id)}
          >
            <Icon name="explore" />
            {t("datasources.drawer.explore")}
          </Link>
        ) : null}
        {access.query ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onTest}
            disabled={entry?.pending === true}
          >
            <Icon name="refresh" />
            {entry?.pending === true
              ? t("datasources.health.testing")
              : t("datasources.drawer.test")}
          </button>
        ) : null}
        {access.write ? (
          <Link
            to="/data-sources/$datasourceId"
            params={{ datasourceId: source.id }}
            className="button button--secondary button--small"
          >
            <Icon name="edit" />
            {t("datasources.drawer.edit")}
          </Link>
        ) : null}
      </div>
      {tabs.length > 1 ? (
        <div
          className="tabs ds-drawer__tabs"
          role="tablist"
          aria-label={t("datasources.drawer.sections")}
          onKeyDown={onTabKey}
        >
          {tabs.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${tabsId}-${name}-tab`}
              className="tabs__tab"
              aria-selected={tab === name}
              aria-controls={`${tabsId}-${name}`}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => setChosen(name)}
            >
              {t(`datasources.drawer.tab.${name}`)}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className="ds-drawer__body"
        {...(tabs.length > 1
          ? {
              role: "tabpanel",
              id: `${tabsId}-${tab}`,
              "aria-labelledby": `${tabsId}-${tab}-tab`,
            }
          : {})}
      >
        {body}
        <p className="ds-drawer__note">
          <Icon name="shieldCheck" />
          <span>{t("datasources.drawer.note")}</span>
        </p>
      </div>
    </aside>
  );
}

/** The caller's own rights on the source, as the highest one in words. */
export function yourAccess(access: DatasourceAccess): MessageKey {
  if (access.permissions) {
    return "datasources.drawer.access.manage";
  }
  if (access.write) {
    return "datasources.drawer.access.edit";
  }
  if (access.query) {
    return "datasources.drawer.access.query";
  }
  return "datasources.drawer.access.read";
}

/**
 * Who has access beyond their role: teams changed in place (each change applies at once and can
 * be undone), then people and roles with the way to the access dialog; the drawer's and the edit
 * page's.
 */
export function AccessSection({
  orgId,
  source,
}: {
  orgId: string;
  source: Pick<DatasourceSummary, "id" | "name">;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  // The same query as the access dialog: a change there shows here at once.
  const grants = usePagedList(adminKeys.grants(orgId, "datasource", source.id), (cursor) =>
    listGrants(orgId, "datasource", source.id, cursor),
  );
  const list = [...(grants.items ?? [])].sort(
    (a, b) => SUBJECT_ORDER.indexOf(a.subjectType) - SUBJECT_ORDER.indexOf(b.subjectType),
  );
  const teamGrants = list.filter((grant) => grant.subjectType === "team");
  const others = list.filter((grant) => grant.subjectType !== "team");
  const subjectName = (grant: Grant) =>
    grant.subjectType === "role" ? roleLabel(t, grant.subjectName, undefined) : grant.subjectName;

  let body = null;
  if (grants.query.isError) {
    body = <p className="ds-drawer__empty">{t("admin.access.cannotSee")}</p>;
  } else if (grants.items === undefined) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else {
    body = (
      <>
        <TeamAccess orgId={orgId} source={source} grants={teamGrants} />
        <h3 className="ds-drawer__section">{t("datasources.drawer.sharedWith")}</h3>
        {others.length === 0 ? (
          <p className="ds-drawer__empty">{t("datasources.access.noOthers")}</p>
        ) : (
          <ul className="ds-grants" aria-label={t("admin.access.listLabel")}>
            {others.map((grant) => (
              <li key={grant.id} className="ds-grants__row">
                <span className="ds-grants__initials" aria-hidden="true">
                  {initials(subjectName(grant))}
                </span>
                <span className="ds-grants__who">
                  <span className="ds-grants__name">{subjectName(grant)}</span>
                  <span className="ds-grants__type">{t(SUBJECT_TEXT[grant.subjectType])}</span>
                </span>
                <span className="ds-grants__level">{t(LEVEL_TEXT[grant.level])}</span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  return (
    <section className="ds-access" aria-labelledby={headingId}>
      <h3 id={headingId} className="visually-hidden">
        {t("datasources.drawer.tab.access")}
      </h3>
      {body}
      {grants.hasMore ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={grants.loadMore}
          disabled={grants.loadingMore}
        >
          {t("datasources.loadMore")}
        </button>
      ) : null}
      <button
        ref={opener}
        type="button"
        className="button button--secondary ds-access__manage"
        onClick={() => setOpen(true)}
      >
        <Icon name="members" />
        {t("datasources.drawer.manageAccess")}
      </button>
      <dl className="ds-levels">
        {(["query", "edit", "admin"] as const).map((level) => (
          <div key={level}>
            <dt>{t(LEVEL_TEXT[level])}</dt>
            <dd>{t(`datasources.drawer.level.${level}`)}</dd>
          </div>
        ))}
      </dl>
      {open ? (
        <AccessDialog
          open
          orgId={orgId}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
          resource={{ type: "datasource", id: source.id, name: source.name }}
        />
      ) : null}
    </section>
  );
}

/** Where the source is used: the dashboards the caller may see, and its queries of the last day. */
function UsageSection({ orgId, source }: { orgId: string; source: DatasourceSummary }) {
  const { t } = useI18n();
  const usage = useQuery(sourceUsageQuery(orgId, source.id));
  if (usage.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (usage.isError) {
    return <p className="ds-drawer__empty">{errorMessage(t, usage.error)}</p>;
  }
  const { dashboards, queries, errors, latency } = usage.data;
  const middle = median(latency.map((point) => point.ms));
  return (
    <section className="ds-usage" aria-label={t("datasources.drawer.tab.usage")}>
      <dl className="ds-facts">
        <div>
          <dt>{t("datasources.usage.queries")}</dt>
          <dd>{queries}</dd>
        </div>
        <div>
          <dt>{t("datasources.usage.errors")}</dt>
          <dd>{errors}</dd>
        </div>
        <div>
          <dt>{t("datasources.usage.latency")}</dt>
          <dd className="ds-cell__line">
            <Sparkline points={latency} />
            <span>
              {middle === null
                ? t("datasources.usage.noQueries")
                : t("datasources.status.ms", { ms: Math.round(middle) })}
            </span>
          </dd>
        </div>
      </dl>
      <h3 className="ds-drawer__section">{t("datasources.usage.dashboards")}</h3>
      {dashboards.length === 0 ? (
        <p className="ds-drawer__empty">{t("datasources.usage.none")}</p>
      ) : (
        <ul className="ds-uses">
          {dashboards.map((dashboard) => (
            <li key={dashboard.id}>
              <Link to="/dashboards/$dashboardId" params={{ dashboardId: dashboard.id }}>
                {dashboard.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What happened to the source, newest first, as the audit log keeps it (without details). */
function HistorySection({ orgId, source }: { orgId: string; source: DatasourceSummary }) {
  const { t } = useI18n();
  const ago = useAgo();
  const history = useQuery(sourceHistoryQuery(orgId, source.id));
  if (history.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (history.isError) {
    return <p className="ds-drawer__empty">{errorMessage(t, history.error)}</p>;
  }
  if (history.data.length === 0) {
    return <p className="ds-drawer__empty">{t("datasources.history.empty")}</p>;
  }
  const now = Date.now();
  return (
    <ol className="ds-history" aria-label={t("datasources.drawer.tab.history")}>
      {history.data.map((item) => (
        <li key={item.id} className="ds-history__row">
          <span>{t(HISTORY_TEXT[item.action] ?? "datasources.history.other")}</span>
          <span className="ds-cell__muted">
            {item.actorName === undefined
              ? ago(item.at, now)
              : t("datasources.history.byAt", { name: item.actorName, ago: ago(item.at, now) })}
          </span>
        </li>
      ))}
    </ol>
  );
}
