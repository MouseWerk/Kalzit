import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { EmptyState } from "../components/EmptyState";
import { FormAlert } from "../components/FormAlert";
import { Icon } from "../components/Icon";
import { Page } from "../components/Page";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../org/useOrg";
import { type DashboardEntry, recentsQuery, search, starsQuery } from "../shell/homeApi";
import { setOverlay } from "../shell/overlay";
import { paletteShortcut } from "../shell/ShortcutsHelp";
import { apiErrorText } from "../shell/shellErrors";
import "../shell/shellUx.css";

const appRoute = getRouteApi("/_app");

/**
 * The start page ("Start"), per user: quick actions, starred and recently opened dashboards, and
 * in an organization that holds nothing yet, the first steps the user may take.
 */
export function HomePage() {
  const { t } = useI18n();
  useDocumentTitle("home.title");
  const { me } = appRoute.useRouteContext();
  const org = useCurrentOrg();
  return (
    <Page title={t("home.welcome", { name: me.name })} lead={t("home.lead")}>
      {org === undefined ? (
        <EmptyState icon="home" title={t("shell.start.noOrg.title")}>
          {t("shell.start.noOrg.text")}
        </EmptyState>
      ) : (
        <Start orgId={org.id} />
      )}
    </Page>
  );
}

function Start({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const stars = useQuery(starsQuery(orgId));
  const recents = useQuery(recentsQuery(orgId));
  // Anything at all the user may open; an empty answer is an organization without content yet.
  const anything = useQuery({
    queryKey: ["home", orgId, "anything"],
    queryFn: ({ signal }) => search(orgId, { q: "", limit: 1 }, signal),
  });
  const fresh = anything.data !== undefined && anything.data.items.length === 0;
  const palette = paletteShortcut();

  const actions: ReactNode[] = [];
  if (permissions.has("dashboards:write")) {
    actions.push(
      <Link
        key="dashboard"
        to="/dashboards"
        search={{ create: "dashboard" }}
        className="button button--primary"
      >
        <Icon name="plus" />
        {t("shell.start.action.newDashboard")}
      </Link>,
    );
  }
  if (permissions.has("datasources:query")) {
    actions.push(
      <Link key="explore" to="/explore" className="button button--secondary">
        <Icon name="explore" />
        {t("shell.start.action.explore")}
      </Link>,
    );
  }
  if (permissions.has("datasources:write")) {
    actions.push(
      <Link
        key="datasource"
        to="/data-sources/new"
        search={{}}
        className="button button--secondary"
      >
        <Icon name="dataSources" />
        {t("shell.start.action.newDatasource")}
      </Link>,
    );
  }
  actions.push(
    <button
      key="search"
      type="button"
      className="button button--secondary"
      aria-keyshortcuts={palette.aria}
      onClick={() => setOverlay("palette")}
    >
      <Icon name="explore" />
      {t("shell.start.action.search", { shortcut: palette.label })}
    </button>,
  );

  return (
    <div className="start">
      <section className="start__actions" aria-label={t("shell.start.actions")}>
        {actions}
      </section>
      {fresh ? <Onboarding /> : null}
      <div className="start__columns">
        <EntryList
          title={t("shell.start.starred")}
          empty={t("shell.start.starredEmpty")}
          query={stars}
        />
        <EntryList
          title={t("shell.start.recent")}
          empty={t("shell.start.recentEmpty")}
          query={recents}
        />
      </div>
    </div>
  );
}

/** First steps in an organization without content, each only for who may take it. */
function Onboarding() {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const titleId = useId();
  const steps: { key: string; title: string; text: string; link: ReactNode }[] = [];
  if (permissions.has("datasources:write")) {
    steps.push({
      key: "datasource",
      title: t("shell.start.onboarding.datasource"),
      text: t("shell.start.onboarding.datasourceText"),
      link: (
        <Link to="/data-sources/new" search={{}} className="button button--primary">
          {t("shell.start.onboarding.datasourceAction")}
        </Link>
      ),
    });
  }
  if (permissions.has("dashboards:write")) {
    steps.push({
      key: "dashboard",
      title: t("shell.start.onboarding.dashboard"),
      text: t("shell.start.onboarding.dashboardText"),
      link: (
        <Link
          to="/dashboards"
          search={{ create: "dashboard" }}
          className="button button--secondary"
        >
          {t("shell.start.onboarding.dashboardAction")}
        </Link>
      ),
    });
  }
  if (permissions.has("users:invite") || permissions.has("users:write")) {
    steps.push({
      key: "members",
      title: t("shell.start.onboarding.members"),
      text: t("shell.start.onboarding.membersText"),
      link: (
        <Link to="/admin/members" className="button button--secondary">
          {t("shell.start.onboarding.membersAction")}
        </Link>
      ),
    });
  }
  return (
    <section className="start__onboarding" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("shell.start.onboarding.title")}</h2>
      {steps.length === 0 ? (
        <p className="start__muted">{t("shell.start.onboarding.nothing")}</p>
      ) : (
        <ol className="start__steps">
          {steps.map((step) => (
            <li key={step.key} className="start__step">
              <h3 className="start__step-title">{step.title}</h3>
              <p className="start__muted">{step.text}</p>
              <div>{step.link}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EntryList({
  title,
  empty,
  query,
}: {
  title: string;
  empty: string;
  query: { data?: { items: DashboardEntry[] } | undefined; isPending: boolean; error: unknown };
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
    body = (
      <ul className="start__list">
        {query.data.items.map((entry) => (
          <li key={entry.id}>
            <Link
              to="/dashboards/$dashboardId"
              params={{ dashboardId: entry.id }}
              className="start__entry"
            >
              <Icon name="dashboards" />
              <span className="start__entry-text">
                <span className="start__entry-title truncate">{entry.title}</span>
                {entry.path.length === 0 ? null : (
                  <span className="start__entry-path truncate">{entry.path.join(" / ")}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="start__section" aria-labelledby={titleId}>
      <h2 id={titleId} className="start__title">
        {title}
      </h2>
      {body}
    </section>
  );
}
