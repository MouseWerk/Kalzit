import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { Shape } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { useOrgPermissions } from "../../org/useOrg";
import { AccessDialog } from "../admin/access";
import { adminKeys, type Grant, listGrants, type SubjectType } from "../admin/api";
import { LEVEL_TEXT, roleLabel, SUBJECT_TEXT } from "../admin/catalog";
import { usePagedList } from "../admin/components/lists";
import { mayManageAccess } from "../dashboards/accessIntegration";
import { openWithSource } from "../explore/lastSource";
import type { DatasourceAccess, DatasourceSummary } from "./api";
import { HealthResult } from "./DataSourceForm";
import { KindMark } from "./kindMarks";
import { StatusLabel } from "./StatusLabel";
import { type HealthEntry, statusOf } from "./sourceStatus";
import "./datasources.css";

const TABS = ["overview", "access"] as const;
type Tab = (typeof TABS)[number];

const SHAPE_TEXT: Record<Shape, MessageKey> = {
  frame: "datasources.shape.frame",
  documents: "datasources.shape.documents",
  graph: "datasources.shape.graph",
};

/** Teams first, as on the board: access is mostly given to teams; then people, then roles. */
const SUBJECT_ORDER: readonly SubjectType[] = ["team", "user", "role"];

/**
 * The side panel of the selected source: its status, the actions on it, an overview and who has
 * access beyond their role. Access is read from the grants the server already keeps and changed
 * in the access dialog; the panel only shows what the caller may see.
 */
export function DataSourceDrawer({
  orgId,
  source,
  kindName,
  shapes,
  added,
  access,
  entry,
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
  const tabs = canManage ? TABS : (["overview"] as const);
  const [chosen, setChosen] = useState<Tab>("overview");
  const tab: Tab = tabs.includes(chosen as never) ? chosen : "overview";
  const status = statusOf(entry);

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.indexOf(tab as never);
    const target: Record<string, number> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    };
    const position = target[event.key];
    if (position === undefined) {
      return;
    }
    event.preventDefault();
    const next = tabs[position] ?? "overview";
    setChosen(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }

  return (
    <aside className="ds-drawer" aria-labelledby={titleId}>
      <div className="ds-drawer__head">
        <KindMark kind={source.kind} />
        <div className="ds-drawer__title">
          <h2 id={titleId} tabIndex={-1}>
            {source.name}
          </h2>
          <span className="ds-drawer__meta">
            <StatusLabel status={status} latencyMs={entry?.health?.latencyMs} />
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
        {tab === "access" ? (
          <AccessSection orgId={orgId} source={source} />
        ) : (
          <>
            <dl className="ds-facts">
              <div>
                <dt>{t("datasources.column.kind")}</dt>
                <dd>{kindName}</dd>
              </div>
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
        )}
        <p className="ds-drawer__note">
          <Icon name="shieldCheck" />
          <span>{t("datasources.drawer.note")}</span>
        </p>
      </div>
    </aside>
  );
}

/** The caller's own rights on the source, as the highest one in words. */
function yourAccess(access: DatasourceAccess): MessageKey {
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

function AccessSection({ orgId, source }: { orgId: string; source: DatasourceSummary }) {
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
  const subjectName = (grant: Grant) =>
    grant.subjectType === "role" ? roleLabel(t, grant.subjectName, undefined) : grant.subjectName;

  let body = null;
  if (grants.query.isError) {
    body = <p className="ds-drawer__empty">{t("admin.access.cannotSee")}</p>;
  } else if (grants.items === undefined) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else if (list.length === 0) {
    body = <p className="ds-drawer__empty">{t("admin.access.none")}</p>;
  } else {
    body = (
      <ul className="ds-grants" aria-label={t("admin.access.listLabel")}>
        {list.map((grant) => (
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
    );
  }
  return (
    <section className="ds-access" aria-labelledby={headingId}>
      <h3 id={headingId} className="ds-drawer__section">
        {t("datasources.drawer.sharedWith")}
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

/** Up to two letters for the avatar: the first of the first two words, or a word's first two. */
export function initials(name: string): string {
  const [first = "", second] = name.trim().split(/\s+/u);
  const letters =
    second === undefined
      ? Array.from(first).slice(0, 2)
      : [Array.from(first)[0] ?? "", Array.from(second)[0] ?? ""];
  return letters.join("").toLocaleUpperCase();
}
