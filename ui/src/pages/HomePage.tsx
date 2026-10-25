import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, type LinkProps } from "@tanstack/react-router";
import { type ReactNode, useId, useMemo } from "react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { EmptyState } from "../components/EmptyState";
import { FormAlert } from "../components/FormAlert";
import { Icon } from "../components/Icon";
import { auditActionLabel } from "../features/admin/catalog";
import { datasourcesNav } from "../features/datasources/nav";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { showErrorToast } from "../lib/toasts";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../org/useOrg";
import {
  type DashboardEntry,
  HOME_KEY,
  recentsQuery,
  search,
  setStarred,
  starredQuery,
  starsQuery,
} from "../shell/homeApi";
import { setOverlay } from "../shell/overlay";
import { SetupChecklist } from "../shell/SetupChecklist";
import { paletteShortcut } from "../shell/ShortcutsHelp";
import { useSidebarColumn } from "../shell/shellContext";
import { apiErrorText } from "../shell/shellErrors";
import {
  ACTIVITY_DAYS,
  activityQuery,
  type Count,
  changeTime,
  dashboardCountQuery,
  datasourceCountQuery,
  memberCountQuery,
  recentChangesQuery,
  relativeTime,
} from "../shell/startData";
import "../shell/shellUx.css";

const appRoute = getRouteApi("/_app");

/** Recently opened dashboards shown as cards; the server keeps more for the palette. */
const RECENT_CARDS = 8;

/**
 * The start page ("Start"), per user: a greeting with quick actions, the organization in numbers,
 * and starred and recently opened dashboards as cards.
 */
export function HomePage() {
  const { t } = useI18n();
  useDocumentTitle("home.title");
  const { me } = appRoute.useRouteContext();
  const org = useCurrentOrg();
  const greeting = t("home.welcome", { name: me.name });
  if (org === undefined) {
    return (
      <div className="start">
        <StartHeader greeting={greeting} />
        <EmptyState icon="home" title={t("shell.start.noOrg.title")}>
          {t("shell.start.noOrg.text")}
        </EmptyState>
      </div>
    );
  }
  return <Start userId={me.id} orgId={org.id} greeting={greeting} />;
}

function StartHeader({ greeting, actions }: { greeting: string; actions?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="start__header">
      <Breadcrumbs crumbs={[{ label: t("home.title") }]} />
      <div className="start__heading">
        <h1 className="start__greeting">{greeting}</h1>
        {actions}
      </div>
    </div>
  );
}

function Start({ userId, orgId, greeting }: { userId: string; orgId: string; greeting: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  // The sidebar's setup card shows only in its full column; otherwise it comes here.
  const sidebarColumn = useSidebarColumn();
  const stars = useQuery(starsQuery(orgId));
  const recents = useQuery(recentsQuery(orgId));
  // Anything at all the user may open; an empty answer is an organization without content yet.
  const anything = useQuery({
    queryKey: [HOME_KEY, orgId, "anything"],
    queryFn: ({ signal }) => search(orgId, { q: "", limit: 1 }, signal),
  });
  const fresh = anything.data !== undefined && anything.data.items.length === 0;
  const palette = paletteShortcut();
  const canCreate =
    permissions.has("dashboards:write") ||
    permissions.has("datasources:write") ||
    permissions.has("users:write") ||
    permissions.has("users:invite");

  const actions: ReactNode[] = [];
  if (permissions.has("dashboards:write")) {
    actions.push(
      <Link
        key="dashboard"
        to="/dashboards"
        search={{ create: "dashboard" }}
        className="button button--primary"
      >
        {t("shell.start.action.newDashboard")}
      </Link>,
    );
  }
  if (permissions.has("datasources:query")) {
    actions.push(
      <Link key="explore" to="/explore" className="button button--secondary">
        {t("shell.start.action.explore")}
      </Link>,
    );
  }

  // Smaller first steps as chips under the numbers.
  const quick: ReactNode[] = [];
  if (permissions.has("datasources:write")) {
    quick.push(
      <Link key="datasource" to="/data-sources/new" search={{}} className="start__chip">
        <Icon name="plus" />
        {t("shell.start.quick.datasource")}
      </Link>,
    );
  }
  if (permissions.has("users:invite") || permissions.has("users:write")) {
    quick.push(
      <Link key="invite" to="/admin/members" className="start__chip">
        <Icon name="plus" />
        {t("shell.start.quick.invite")}
      </Link>,
    );
  }
  quick.push(
    <button
      key="search"
      type="button"
      className="start__chip"
      aria-keyshortcuts={`/ ${palette.aria}`}
      onClick={() => setOverlay("palette")}
    >
      <Icon name="search" />
      {t("shell.start.action.search", { shortcut: palette.label })}
    </button>,
  );
  const starredIds = new Set((stars.data?.items ?? []).map((entry) => entry.id));

  return (
    <div className="start">
      <StartHeader
        greeting={greeting}
        actions={
          <section className="start__actions" aria-label={t("shell.start.actions")}>
            {actions}
          </section>
        }
      />
      {/* Where the sidebar is a bar on top, its setup card moves here, first in view. */}
      {sidebarColumn ? null : (
        <SetupChecklist key={`${userId}:${orgId}`} userId={userId} orgId={orgId} placement="page" />
      )}
      <Stats orgId={orgId} />
      <section className="start__quick" aria-label={t("shell.start.quickStart")}>
        <span className="start__quick-label" aria-hidden="true">
          {t("shell.start.quickStart")}
        </span>
        {quick}
      </section>
      {fresh && !canCreate ? (
        <EmptyState icon="dashboards" title={t("shell.start.empty.title")}>
          {t("shell.start.empty.text")}
        </EmptyState>
      ) : null}
      <EntryCards
        orgId={orgId}
        title={t("shell.start.starred")}
        empty={t("shell.start.starredEmpty")}
        query={stars}
        starredIds={starredIds}
        more={
          <Link to="/dashboards" className="start__more">
            {t("shell.start.allDashboards")}
          </Link>
        }
      />
      <EntryCards
        orgId={orgId}
        title={t("shell.start.recent")}
        empty={t("shell.start.recentEmpty")}
        query={recents}
        limit={RECENT_CARDS}
        starredIds={starredIds}
        compact
      />
      {permissions.has("audit:read") && permissions.loaded ? <RecentChanges orgId={orgId} /> : null}
    </div>
  );
}

// Stat tiles

interface StatSpec {
  key: string;
  label: MessageKey;
  to: NonNullable<LinkProps["to"]>;
  count: Count | undefined;
  failed: boolean;
  well: ReactNode;
  /** Words for what the well shows, where it carries data (the sparkline). */
  summary?: string | undefined;
}

/** The organization in numbers, each a link to where the things are; only what the user may see. */
function Stats({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const canDatasources = datasourcesNav.visible?.(permissions) ?? true;
  const canMembers = permissions.has("users:read");
  const canAudit = permissions.has("audit:read");
  const dashboards = useQuery(dashboardCountQuery(orgId));
  const datasources = useQuery({ ...datasourceCountQuery(orgId), enabled: canDatasources });
  const members = useQuery({ ...memberCountQuery(orgId), enabled: canMembers });
  const activity = useQuery({ ...activityQuery(orgId), enabled: canAudit });

  const stats: StatSpec[] = [
    {
      key: "dashboards",
      label: "shell.start.stat.dashboards",
      to: "/dashboards",
      count: dashboards.data,
      failed: dashboards.isError,
      well: <DashboardsArt />,
    },
  ];
  if (canDatasources) {
    stats.push({
      key: "datasources",
      label: "shell.start.stat.datasources",
      to: "/data-sources",
      count: datasources.data,
      failed: datasources.isError,
      well: <DatasourcesArt />,
    });
  }
  if (canMembers && permissions.loaded) {
    stats.push({
      key: "members",
      label: "shell.start.stat.members",
      to: "/admin/members",
      count: members.data,
      failed: members.isError,
      well: <MembersArt />,
    });
  }
  if (canAudit && permissions.loaded) {
    stats.push({
      key: "activity",
      label: "shell.start.stat.activity",
      to: "/admin/audit",
      count: activity.data?.total,
      failed: activity.isError,
      well: <Sparkline values={activity.data?.perDay ?? []} />,
      summary: activitySummary(t, activity.data?.perDay),
    });
  }

  return (
    <section aria-label={t("shell.start.stats")}>
      <ul className="start__stats">
        {stats.map((stat) => (
          <li key={stat.key}>
            <Link to={stat.to} className="stat-tile">
              <span className="stat-tile__text">
                <span className="stat-tile__label">{t(stat.label)}</span>
                <StatValue count={stat.count} failed={stat.failed} />
                {stat.summary === undefined ? null : (
                  <span className="visually-hidden">{stat.summary}</span>
                )}
              </span>
              <span className="stat-tile__well" aria-hidden="true">
                {stat.well}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatValue({ count, failed }: { count: Count | undefined; failed: boolean }) {
  const { t, language } = useI18n();
  if (count === undefined) {
    return failed ? (
      <span className="stat-tile__value stat-tile__value--none">
        {t("shell.start.stat.unknown")}
      </span>
    ) : (
      <span className="stat-tile__value">
        <span className="stat-tile__skeleton skeleton" />
        <span className="visually-hidden">{t("common.loading")}</span>
      </span>
    );
  }
  const value = new Intl.NumberFormat(language).format(count.value);
  return (
    <span className="stat-tile__value">
      {count.more ? t("shell.start.stat.more", { count: value }) : value}
    </span>
  );
}

/*
 * Illustrations for the wells: drawn from the surface, border and muted text tokens, so they sit
 * quietly in every theme. Decorative; the label and number carry the meaning.
 */

function DashboardsArt() {
  return (
    <svg className="art" aria-hidden="true" viewBox="0 0 64 48" focusable="false">
      <rect className="art__sheet" x="10" y="2" width="50" height="40" rx="5" />
      <rect className="art__sheet art__sheet--front" x="4" y="7" width="50" height="39" rx="5" />
      <rect className="art__panel" x="9" y="12" width="18" height="12" rx="2" />
      <rect className="art__panel" x="30" y="12" width="19" height="12" rx="2" />
      <path className="art__line" d="M10 39 17 33l6 3 7-7 7 4 11-6" />
    </svg>
  );
}

function DatasourcesArt() {
  return (
    <svg className="art" aria-hidden="true" viewBox="0 0 64 48" focusable="false">
      <path className="art__sheet" d="M14 10c0-4 8-7 18-7s18 3 18 7v28c0 4-8 7-18 7s-18-3-18-7z" />
      <ellipse className="art__sheet art__sheet--front" cx="32" cy="10" rx="18" ry="7" />
      <path className="art__line" d="M14 20c0 4 8 7 18 7s18-3 18-7M14 30c0 4 8 7 18 7s18-3 18-7" />
    </svg>
  );
}

function MembersArt() {
  return (
    <svg className="art" aria-hidden="true" viewBox="0 0 64 48" focusable="false">
      <circle className="art__sheet" cx="44" cy="20" r="11" />
      <circle className="art__sheet" cx="20" cy="20" r="11" />
      <circle className="art__sheet art__sheet--front" cx="32" cy="24" r="13" />
      <circle className="art__line" cx="32" cy="20" r="4" />
      <path className="art__line" d="M24 33a8 8 0 0 1 16 0" />
    </svg>
  );
}

/** The sparkline in words, for screen readers: today's changes and the busiest known day. */
function activitySummary(
  t: ReturnType<typeof useI18n>["t"],
  perDay: (number | null)[] | undefined,
): string | undefined {
  if (perDay === undefined) {
    return undefined;
  }
  const known = perDay.filter((value): value is number => value !== null);
  return t("shell.start.stat.activitySummary", {
    today: String(perDay.at(-1) ?? 0),
    busiest: String(Math.max(0, ...known)),
  });
}

/**
 * Changes per day as a small line, in the text color; flat until the numbers arrive. Days the
 * capped reading did not reach are left out instead of drawn as zero.
 */
function Sparkline({ values }: { values: (number | null)[] }) {
  const width = 64;
  const height = 40;
  const points: (number | null)[] =
    values.length > 0 ? values : Array.from({ length: ACTIVITY_DAYS }, () => 0);
  const max = Math.max(1, ...points.filter((value): value is number => value !== null));
  const step = width / Math.max(1, points.length - 1);
  let pen = "M";
  const path = points
    .map((value, index) => {
      if (value === null) {
        pen = "M";
        return "";
      }
      const x = index * step;
      // A pixel of room top and bottom, so the stroke is never cut.
      const y = height - 2 - (value / max) * (height - 4);
      const segment = `${pen}${x.toFixed(1)} ${y.toFixed(1)}`;
      pen = "L";
      return segment;
    })
    .filter((segment) => segment !== "")
    .join(" ");
  return (
    <svg
      className="art art--spark"
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      focusable="false"
    >
      <path className="art__grid" d={`M0 ${height - 1}H${width}`} />
      <path className="art__spark" d={path} />
    </svg>
  );
}

// Dashboard cards

function EntryCards({
  orgId,
  title,
  empty,
  query,
  limit,
  starredIds,
  more,
  compact = false,
}: {
  orgId: string;
  title: string;
  empty: string;
  query: { data?: { items: DashboardEntry[] } | undefined; isPending: boolean; error: unknown };
  limit?: number;
  starredIds: ReadonlySet<string>;
  /** A link on the right of the heading, such as "All dashboards". */
  more?: ReactNode;
  /** Short entries (title, folder and time) instead of cards with a thumbnail and actions. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const titleId = useId();
  let body: ReactNode;
  if (query.isPending) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else if (query.data === undefined) {
    body = <FormAlert>{apiErrorText(t, query.error)}</FormAlert>;
  } else if (query.data.items.length === 0) {
    body = <p className="start__muted">{empty}</p>;
  } else {
    const items = limit === undefined ? query.data.items : query.data.items.slice(0, limit);
    body = compact ? (
      <ul className="start__recent">
        {items.map((entry) => (
          <RecentCard key={entry.id} entry={entry} />
        ))}
      </ul>
    ) : (
      <ul className="start__cards">
        {items.map((entry) => (
          <DashboardCard
            key={entry.id}
            orgId={orgId}
            entry={entry}
            starred={starredIds.has(entry.id)}
          />
        ))}
      </ul>
    );
  }
  return (
    <section className="start__section" aria-labelledby={titleId}>
      <div className="start__section-head">
        <h2 id={titleId} className="start__title">
          {title}
        </h2>
        {more}
      </div>
      {body}
    </section>
  );
}

/** "Vertrieb", or "No folder", the folder path of a dashboard. */
function folderOf(t: ReturnType<typeof useI18n>["t"], entry: DashboardEntry): string {
  return entry.path.length === 0 ? t("shell.start.noFolder") : entry.path.join(" / ");
}

/** "2 hours ago" in the UI language for a time in Unix milliseconds (relativeTime). */
function useRelativeTime(): (at: number) => string {
  const { t, language } = useI18n();
  const format = useMemo(
    () => new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" }),
    [language],
  );
  return (at) => relativeTime(format, at, Date.now(), t("shell.start.justNow"));
}
/** The card's thumbnail: a small sheet of panels, the same for every dashboard. */
function DashboardThumb() {
  return (
    <span className="dash-card__tile" aria-hidden="true">
      <svg className="dash-card__thumb" aria-hidden="true" viewBox="0 0 92 68" focusable="false">
        <rect className="thumb__tab" x="0.5" y="0.5" width="30" height="12" rx="5" />
        <rect className="thumb__sheet" x="0.5" y="6.5" width="91" height="61" rx="7" />
        <rect className="thumb__panel" x="7" y="13" width="35" height="20" rx="3" />
        <rect className="thumb__panel" x="47" y="13" width="38" height="20" rx="3" />
        <rect className="thumb__panel" x="7" y="38" width="78" height="23" rx="3" />
        <path className="thumb__line" d="M12 55l10-6 9 3 11-8 10 5 11-6 9 2" />
      </svg>
    </span>
  );
}

/**
 * A favorite as a card: a thumbnail tile, its title and folder, Open and Edit, and a star to take
 * it off the favorites.
 */
function DashboardCard({
  orgId,
  entry,
  starred,
}: {
  orgId: string;
  entry: DashboardEntry;
  starred: boolean;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const titleId = useId();
  const toggle = useMutation({
    mutationFn: (next: boolean) => setStarred(orgId, entry.id, next),
    onSuccess: (_result, next) => {
      queryClient.setQueryData(starredQuery(orgId, entry.id).queryKey, next);
    },
    onError: (error) => showErrorToast(apiErrorText(t, error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [HOME_KEY, orgId, "stars"] }),
  });
  // The star shows the change at once, before the server answers.
  const on = toggle.isPending ? toggle.variables : starred;
  return (
    <li className="dash-card">
      <DashboardThumb />
      <div className="dash-card__head">
        <h3 id={titleId} className="dash-card__title">
          <Link
            to="/dashboards/$dashboardId"
            params={{ dashboardId: entry.id }}
            className="dash-card__link truncate"
          >
            {entry.title}
          </Link>
        </h3>
        <button
          type="button"
          className="button button--ghost button--small dash-card__star"
          aria-pressed={on}
          aria-label={t("shell.start.starToggle")}
          aria-describedby={titleId}
          title={on ? t("shell.star.starred") : t("shell.star.star")}
          onClick={() => toggle.mutate(!on)}
        >
          <Icon name={on ? "starFilled" : "star"} />
        </button>
      </div>
      <p className="dash-card__path truncate">{folderOf(t, entry)}</p>
      <div className="dash-card__actions">
        <Link
          to="/dashboards/$dashboardId"
          params={{ dashboardId: entry.id }}
          className="button button--secondary button--small"
          aria-label={t("shell.start.openNamed", { title: entry.title })}
        >
          {t("shell.start.open")}
        </Link>
        {permissions.has("dashboards:write") ? (
          <Link
            to="/dashboards/$dashboardId"
            params={{ dashboardId: entry.id }}
            search={{ edit: true }}
            className="button button--ghost button--small"
            aria-label={t("shell.start.editNamed", { title: entry.title })}
          >
            {t("shell.start.edit")}
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** A recently opened dashboard: its title as the link, folder and when it was opened. */
function RecentCard({ entry }: { entry: DashboardEntry }) {
  const { t } = useI18n();
  const relative = useRelativeTime();
  return (
    <li>
      <Link
        to="/dashboards/$dashboardId"
        params={{ dashboardId: entry.id }}
        className="recent-card"
      >
        <span className="recent-card__title truncate">{entry.title}</span>
        <span className="recent-card__meta truncate">
          {folderOf(t, entry)} · {relative(entry.at)}
        </span>
      </Link>
    </li>
  );
}

/** Changes in the organization, newest first: who did what and when (needs `audit:read`). */
function RecentChanges({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const titleId = useId();
  const changes = useQuery(recentChangesQuery(orgId));
  let body: ReactNode;
  if (changes.isPending) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else if (changes.data === undefined) {
    body = <FormAlert>{apiErrorText(t, changes.error)}</FormAlert>;
  } else if (changes.data.length === 0) {
    body = <p className="start__muted">{t("shell.start.changesEmpty")}</p>;
  } else {
    const now = Date.now();
    body = (
      <ul className="start__changes">
        {changes.data.map((event) => (
          <li key={event.id} className="start__change">
            <span className="start__change-time">
              {changeTime(event.createdAt, now, language, timeZone)}
            </span>
            <span className="truncate">
              {t("shell.start.change", {
                actor: event.actorName ?? t("shell.start.someone"),
                action: auditActionLabel(t, event.action),
              })}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="start__section" aria-labelledby={titleId}>
      <div className="start__section-head">
        <h2 id={titleId} className="start__title">
          {t("shell.start.changes")}
        </h2>
        <Link to="/admin/audit" className="start__more">
          {t("shell.start.allChanges")}
        </Link>
      </div>
      {body}
    </section>
  );
}
