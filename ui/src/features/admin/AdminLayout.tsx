import { Link, Outlet } from "@tanstack/react-router";
import { useId } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useOrgPermissions } from "../../org/useOrg";
import "./admin.css";
import { type AdminSectionLink, ORG_SECTIONS, SERVER_SECTIONS, useAdminAccess } from "./sections";
import { canOpenAdministration } from "./visibility";

/** The administration frame: heading, the list of sections the user may open, the section. */
export function AdminLayout() {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const access = useAdminAccess();
  const orgSections = ORG_SECTIONS.filter((section) => section.visible(access));
  const serverSections = SERVER_SECTIONS.filter((section) => section.visible(access));

  let body = null;
  if (canOpenAdministration(permissions)) {
    body = (
      <div className="admin-layout">
        <nav className="admin-nav" aria-label={t("admin.sections")}>
          <SectionLinks title={t("admin.group.org")} sections={orgSections} />
          <SectionLinks title={t("admin.group.server")} sections={serverSections} />
        </nav>
        <div className="admin-layout__content">
          <Outlet />
        </div>
      </div>
    );
  } else if (permissions.loaded) {
    // Only once the permissions are known, so a permitted user never sees "No access" flash.
    body = (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("admin.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("admin.title")} lead={t("admin.lead")}>
      {body}
    </Page>
  );
}

function SectionLinks({
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
    <div className="admin-nav__group">
      <p className="admin-nav__title" id={titleId}>
        {title}
      </p>
      <ul className="admin-nav__list" aria-labelledby={titleId}>
        {sections.map((section) => (
          <li key={section.to}>
            <Link to={section.to} className="admin-nav__link">
              {t(section.label)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The administration's start: every section the user may open, with what it is for. */
export function AdminOverview() {
  const { t } = useI18n();
  useDocumentTitle("admin.title");
  const access = useAdminAccess();
  const orgSections = ORG_SECTIONS.filter((section) => section.visible(access));
  const serverSections = SERVER_SECTIONS.filter((section) => section.visible(access));
  return (
    <div className="admin-overview">
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
