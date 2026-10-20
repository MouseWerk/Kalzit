import { getRouteApi, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Icon } from "../components/Icon";
import { NAV_ITEMS } from "../features/nav";
import { useI18n } from "../i18n/i18n";
import { openLayerCount } from "../lib/layers";
import { currentOrgOf, useOrgPermissions } from "../org/useOrg";
import { UserMenu } from "./UserMenu";

const appRoute = getRouteApi("/_app");

/**
 * Sidebar, account menu and the page outlet. F6 and Shift+F6 move focus between the navigation
 * and the main content, as in desktop apps.
 */
export function AppShell() {
  const { t } = useI18n();
  const { me } = appRoute.useRouteContext();
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const permissions = useOrgPermissions();
  const items = NAV_ITEMS.filter((item) => item.visible?.(permissions) ?? true);
  const currentOrg = currentOrgOf(me);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "F6" || openLayerCount() > 0) {
        return;
      }
      const nav = navRef.current;
      const main = mainRef.current;
      if (nav === null || main === null) {
        return;
      }
      event.preventDefault();
      // With two regions, F6 and Shift+F6 both land on the other one; from anywhere else (the
      // account menu button) focus goes to the navigation first.
      if (nav.contains(document.activeElement)) {
        main.focus();
        return;
      }
      const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
      (current ?? nav.querySelector<HTMLElement>("a"))?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // A button rather than a "#main" link: a hash link would add an entry to the router's history.
  function skipToContent() {
    mainRef.current?.focus();
  }

  return (
    <div className="shell">
      <button type="button" className="skip-link" onClick={skipToContent}>
        {t("common.skipToContent")}
      </button>
      <header className="shell__sidebar">
        <Link to="/" className="shell__brand">
          <span className="shell__brand-name">
            <Icon name="logo" />
            {t("app.name")}
          </span>
          {currentOrg === undefined ? null : (
            <span className="shell__org truncate" title={currentOrg.name}>
              {currentOrg.name}
            </span>
          )}
        </Link>
        <nav ref={navRef} className="shell__nav" aria-label={t("nav.label")}>
          <ul className="shell__nav-list">
            {items.map((item) => (
              <li key={item.to}>
                {/* The title is the tooltip when narrow screens show only the icon. */}
                <Link
                  to={item.to}
                  className="nav-link"
                  title={t(item.label)}
                  activeOptions={{ exact: item.exact === true }}
                >
                  <Icon name={item.icon} />
                  <span className="nav-link__label">{t(item.label)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <UserMenu me={me} />
      </header>
      <main ref={mainRef} id="main" className="shell__main" tabIndex={-1}>
        <div className="shell__content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
