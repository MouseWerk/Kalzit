import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useId } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useOrgPermissions } from "../../org/useOrg";
import { isWithin } from "../../shell/navItem";
import "./admin.css";
import { Notice, useNotice } from "./components/Notice";
import { type AdminSectionLink, ORG_SECTIONS, SERVER_SECTIONS, useAdminAccess } from "./sections";
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
  return (
    <>
      <AdminCrumbs />
      <Page title={t("admin.title")} lead={t("admin.lead")}>
        {body}
      </Page>
    </>
  );
}

/** Administration, then the section the page belongs to; nothing on the overview itself. */
function AdminCrumbs() {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const section = [...ORG_SECTIONS, ...SERVER_SECTIONS]
    .filter((candidate) => isWithin(pathname, candidate.to))
    .sort((a, b) => b.to.length - a.to.length)[0];
  if (section === undefined) {
    return null;
  }
  return (
    <Breadcrumbs
      crumbs={[
        { label: t("admin.title"), link: { to: "/admin" } },
        pathname === section.to
          ? { label: t(section.label) }
          : { label: t(section.label), link: { to: section.to } },
        ...(pathname === section.to ? [] : [{ label: t("shell.breadcrumbs.detail") }]),
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
        sections={orgSections}
      />
      <OverviewGroup title={t("admin.group.server")} sections={serverSections} />
    </div>
  );
}

function OverviewGroup({
  title,
  sections,
}: {
  title: string;
  sections: readonly AdminSectionLink[];
}) {
  const { t } = useI18n();
  const titleId = useId();
  if (sections.length === 0) {
    return null;
  }
  return (
    <section className="admin-overview__group" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <ul className="admin-cards">
        {sections.map((section) => (
          <li key={section.to}>
            <Link to={section.to} className="admin-card">
              <span className="admin-card__title">{t(section.label)}</span>
              <span className="admin-card__text">{t(section.description)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
