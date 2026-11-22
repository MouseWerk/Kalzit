import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useId } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useOrgPermissions } from "../../org/useOrg";
import { useCrumbTitle } from "../../shell/crumbTitle";
import { isWithin } from "../../shell/navItem";
import "./admin.css";
import { Notice, useNotice } from "./components/Notice";
import { type AdminSectionLink, ORG_SECTIONS, SERVER_SECTIONS, useAdminAccess } from "./sections";
import { getUpdates, updateKeys } from "./server/updatesApi";
import { canOpenAdministration } from "./visibility";

/**
 * The administration frame: heading and the section. The sections are listed as sub-pages of
 * the administration in the main navigation (features/admin/nav.ts) and on the overview.
 */
export function AdminLayout() {
  const { t } = useI18n();
  const permissions = useOrgPermissions();

  let body = null;
  if (canOpenAdministration(permissions)) {
    body = <Outlet />;
  } else if (permissions.loaded) {
    // Only once the permissions are known, so a permitted user never sees "No access" flash.
    body = (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("admin.forbidden.text")}
      </EmptyState>
    );
  }
  // The overview carries the administration's heading (AdminHeader); a section page is headed
  // by its own name (Section), with the administration in the breadcrumbs, not a second heading.
  return (
    <>
      <AdminCrumbs />
      <div className="page">
        {permissions.loaded && !canOpenAdministration(permissions) ? <AdminHeader /> : null}
        {body}
      </div>
    </>
  );
}

/** The administration's own heading and lead, on the overview and where it cannot be opened. */
function AdminHeader() {
  const { t } = useI18n();
  return (
    <div className="page__header">
      <h1>{t("admin.title")}</h1>
      <p className="page__lead">{t("admin.lead")}</p>
    </div>
  );
}

/** Administration, then the section the page belongs to; on the overview its own name alone. */
function AdminCrumbs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const page = useCrumbTitle();
  const section = [...ORG_SECTIONS, ...SERVER_SECTIONS]
    .filter((candidate) => isWithin(pathname, candidate.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
  if (section === undefined) {
    return <Breadcrumbs crumbs={[{ label: t("admin.title") }]} />;
  }
  return (
    <Breadcrumbs
      crumbs={[
        { label: t("admin.title"), link: { to: "/admin" } },
        pathname === section.to
          ? { label: t(section.label) }
          : { label: t(section.label), link: { to: section.to } },
        ...(pathname === section.to ? [] : [{ label: page ?? t("shell.breadcrumbs.detail") }]),
      ]}
    />
  );
}

/**
 * The administration's start: every section the user may open, with what it is for. A change
 * that ends here (giving up one's own server admin role) confirms itself in the notice area.
 */
export function AdminOverview() {
  const { t } = useI18n();
  useDocumentTitle("admin.title");
  const notice = useNotice();
  const access = useAdminAccess();
  const orgSections = ORG_SECTIONS.filter((section) => section.visible(access));
  const serverSections = SERVER_SECTIONS.filter((section) => section.visible(access));
  // A role may hold a change permission without the matching read permission (users:write
  // without users:read); then no section opens, and the page says so instead of staying blank.
  const nothing = access.loaded && orgSections.length === 0 && serverSections.length === 0;
  return (
    <>
      <AdminHeader />
      <div className="admin-overview">
        <Notice notice={notice.notice} onDismiss={notice.clear} />
        {nothing ? (
          <EmptyState icon="lock" title={t("admin.overview.emptyTitle")}>
            {t("admin.overview.emptyText")}
          </EmptyState>
        ) : null}
        <OverviewGroup
          title={
            access.orgName === undefined
              ? t("admin.group.org")
              : t("admin.group.orgNamed", { name: access.orgName })
          }
          hint={t("admin.overview.orgHint")}
          sections={orgSections}
        />
        <OverviewGroup
          title={t("admin.group.server")}
          hint={t("admin.overview.serverHint")}
          sections={serverSections}
        />
      </div>
    </>
  );
}

function OverviewGroup({
  title,
  hint,
  sections,
}: {
  title: string;
  hint: string;
  sections: readonly AdminSectionLink[];
}) {
  const { t } = useI18n();
  const titleId = useId();
  if (sections.length === 0) {
    return null;
  }
  // The sections in their small groups (people and access, operations, ...), in list order.
  const clusters = new Map<MessageKey, AdminSectionLink[]>();
  for (const section of sections) {
    clusters.set(section.cluster, [...(clusters.get(section.cluster) ?? []), section]);
  }
  return (
    <section className="admin-overview__group" aria-labelledby={titleId}>
      <div className="admin-overview__heading">
        <h2 id={titleId}>{title}</h2>
        <p className="admin-overview__hint">{hint}</p>
      </div>
      <div className="admin-overview__clusters">
        {[...clusters].map(([cluster, links]) => (
          <OverviewCluster key={cluster} title={t(cluster)} sections={links} />
        ))}
      </div>
    </section>
  );
}

function OverviewCluster({
  title,
  sections,
}: {
  title: string;
  sections: readonly AdminSectionLink[];
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <div className="admin-overview__cluster">
      <h3 id={titleId} className="admin-overview__cluster-title">
        {title}
      </h3>
      <ul className="admin-rows" aria-labelledby={titleId}>
        {sections.map((section) => (
          <li key={section.to}>
            <Link to={section.to} className="admin-row">
              <span className="admin-row__icon" aria-hidden="true">
                <Icon name={section.icon} />
              </span>
              <span className="admin-row__text">
                <span className="admin-row__title">{t(section.label)}</span>
                <span className="admin-row__summary">{t(section.summary)}</span>
              </span>
              <SectionStatus section={section} />
              <Icon name="chevron" className="admin-row__chevron" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A short state at the end of a row, where the overview knows one without extra requests. */
function SectionStatus({ section }: { section: AdminSectionLink }) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const updates = useQuery({
    queryKey: updateKeys.status,
    queryFn: getUpdates,
    enabled: section.to === "/admin/server/updates" && access.isServerAdmin,
    staleTime: 60_000,
  });
  const available = updates.data?.available;
  if (section.to !== "/admin/server/updates" || available == null) {
    return null;
  }
  return (
    <span className="admin-row__status">
      {t("admin.overview.updateAvailable", { version: available.version })}
    </span>
  );
}
