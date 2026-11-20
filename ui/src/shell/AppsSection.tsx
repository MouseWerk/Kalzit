import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { type MouseEvent, useId } from "react";
import { Icon } from "../components/Icon";
import { appInitials, appsQuery, pageTitle } from "../features/plugins/apps/api";
import { useI18n } from "../i18n/i18n";
import "./shellUx.css";

/**
 * The pages of the apps the user may use, under "Apps" (board Settings075.dc.html, frame 10).
 * Without an app there is no section at all. An app with one page is one entry by the app's
 * name; one with several is its name with the pages below it by their own titles, so a long app
 * name never hides which page an entry opens.
 */
export function AppsSection({ orgId, heading }: { orgId: string; heading: boolean }) {
  const { t, language } = useI18n();
  const headingId = useId();
  const apps = useQuery(appsQuery(orgId));
  const items = apps.data ?? [];
  // The app whose page is open, if any: its entry keeps the weight of "within".
  const openApp = useParams({ strict: false, select: (params) => params.appId });
  if (items.length === 0) {
    return null;
  }
  return (
    <>
      <hr className="shell__divider" />
      <section className="shell__pins" aria-labelledby={headingId}>
        <h2 id={headingId} className={heading ? "shell__group-heading" : "visually-hidden"}>
          {t("shell.apps.title")}
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
          {(heading ? items : []).map((app) => {
            const [first, ...more] = app.pages;
            if (first === undefined) {
              return null;
            }
            const several = more.length > 0;
            return (
              <li key={app.id}>
                {several ? (
                  <AppName
                    appId={app.id}
                    pageId={first.id}
                    name={app.name}
                    within={openApp === app.id}
                  />
                ) : (
                  <Link
                    to="/apps/$appId/$pageId"
                    params={{ appId: app.id, pageId: first.id }}
                    className="nav-link"
                    title={app.name}
                  >
                    <Icon name="plugin" />
                    <span className="nav-link__label">{app.name}</span>
                  </Link>
                )}
                {several ? (
                  <ul className="nav-sub" aria-label={app.name}>
                    {app.pages.map((page) => (
                      <li key={page.id}>
                        <Link
                          to="/apps/$appId/$pageId"
                          params={{ appId: app.id, pageId: page.id }}
                          className="nav-sublink"
                          // Its own title is what is read; the name says which app it is of.
                          aria-label={`${app.name}: ${pageTitle(page, language)}`}
                        >
                          <span className="nav-sublink__label">{pageTitle(page, language)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/**
 * The name of an app with several pages: it opens the first page, and is never itself the
 * current page (`aria-current`): that is the page's own entry below it. While a page of the app
 * is open the name keeps to weight, like an entry of the navigation whose sub-page is open. The
 * router's link marks every link to the open address as current, so this is a plain link that
 * hands its click to the router.
 */
function AppName({
  appId,
  pageId,
  name,
  within,
}: {
  appId: string;
  pageId: string;
  name: string;
  within: boolean;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const target = { to: "/apps/$appId/$pageId", params: { appId, pageId } } as const;
  const href = router.history.createHref(router.buildLocation(target).publicHref);
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    // A click with a modifier or another button opens a tab or a window: the browser's own.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    void navigate(target);
  }
  return (
    <a
      href={href}
      className={within ? "nav-link nav-link--within" : "nav-link"}
      title={name}
      onClick={onClick}
    >
      <Icon name="plugin" />
      <span className="nav-link__label">{name}</span>
    </a>
  );
}
