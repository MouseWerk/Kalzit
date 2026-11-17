import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { Icon } from "../components/Icon";
import { appInitials, appsQuery, pageTitle } from "../features/plugins/apps/api";
import { useI18n } from "../i18n/i18n";
import "./shellUx.css";

/**
 * The pages of the apps the user may use, under "Apps" (board Settings075.dc.html, frame 10).
 * Without an app there is no section at all. An app with one page is named by the app, one with
 * several by app and page.
 */
export function AppsSection({ orgId, heading }: { orgId: string; heading: boolean }) {
  const { t, language } = useI18n();
  const headingId = useId();
  const apps = useQuery(appsQuery(orgId));
  const items = apps.data ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <hr className="shell__divider" />
      <section className="shell__pins" aria-labelledby={headingId}>
        <h2 id={headingId} className={heading ? "shell__group-heading" : "visually-hidden"}>
          {t("apps.title")}
        </h2>
        <ul className="shell__nav-list">
          {heading
            ? null
            : items.map((app) => (
                // Without room for names: the app by its initials; its pages are in its bar.
                <li key={app.id}>
                  <Link
                    to="/apps/$appId/$pageId"
                    params={{ appId: app.id, pageId: app.pages[0]?.id ?? "" }}
                    className="nav-link"
                    title={app.name}
                    activeOptions={{ exact: false }}
                  >
                    <span className="shell__app-mark" aria-hidden="true">
                      {appInitials(app.name)}
                    </span>
                    <span className="nav-link__label">{app.name}</span>
                  </Link>
                </li>
              ))}
          {(heading ? items : []).flatMap((app) =>
            app.pages.map((page) => {
              const name =
                app.pages.length === 1 ? app.name : `${app.name}: ${pageTitle(page, language)}`;
              return (
                <li key={`${app.id}/${page.id}`}>
                  <Link
                    to="/apps/$appId/$pageId"
                    params={{ appId: app.id, pageId: page.id }}
                    className="nav-link"
                    title={name}
                  >
                    <Icon name="plugin" />
                    <span className="nav-link__label">{name}</span>
                  </Link>
                </li>
              );
            }),
          )}
        </ul>
      </section>
    </>
  );
}
