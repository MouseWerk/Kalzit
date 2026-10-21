import { getRouteApi, Link, Outlet } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NAV_ITEMS } from "../features/nav";
import { useI18n } from "../i18n/i18n";
import { openLayerCount } from "../lib/layers";
import { currentOrgOf, useOrgPermissions } from "../org/useOrg";
import { NavEntry } from "./NavEntry";
import {
  isToggleShortcut,
  isTypingTarget,
  readCollapsed,
  sidebarShortcut,
  useWideLayout,
  writeCollapsed,
} from "./sidebarState";
import { UserMenu } from "./UserMenu";

const appRoute = getRouteApi("/_app");

/**
 * Sidebar, account menu and the page outlet. F6 and Shift+F6 move focus between the navigation
 * and the main content, as in desktop apps. The sidebar collapses to an icon rail with its
 * toggle or Ctrl+B (Cmd+B on macOS); each viewer's choice is remembered.
 */
export function AppShell() {
  const { t } = useI18n();
  const { me } = appRoute.useRouteContext();
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sidebarId = useId();
  const permissions = useOrgPermissions();
  const items = NAV_ITEMS.filter((item) => item.visible?.(permissions) ?? true);
  const currentOrg = currentOrgOf(me);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const wide = useWideLayout();
  // Below the column breakpoint the sidebar is a bar on top; it has nothing to collapse.
  const rail = collapsed && wide;
  const shortcut = sidebarShortcut();
  // The rail's flyouts are layers for Escape, but not dialogs: F6 and Ctrl+B still work.
  const openFlyouts = useRef(0);

  function onFlyoutChange(open: boolean) {
    openFlyouts.current += open ? 1 : -1;
  }

  function blockingLayers(): boolean {
    return openLayerCount() - openFlyouts.current > 0;
  }

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (isToggleShortcut(event)) {
      if (!wide || event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      toggleSidebar();
      return;
    }
    if (event.key !== "F6" || blockingLayers()) {
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
    // The current page, else the entry it lies in (the rail hides sub-pages), else the first.
    const current =
      nav.querySelector<HTMLElement>('[aria-current="page"]') ??
      nav.querySelector<HTMLElement>('[aria-current="true"]');
    (current ?? nav.querySelector<HTMLElement>("a"))?.focus();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // A button rather than a "#main" link: a hash link would add an entry to the router's history.
  function skipToContent() {
    mainRef.current?.focus();
  }

  const toggleLabel = t("nav.sidebar");
  return (
    <div className="shell" data-sidebar={rail ? "collapsed" : "expanded"}>
      <button type="button" className="skip-link" onClick={skipToContent}>
        {t("common.skipToContent")}
      </button>
      <header id={sidebarId} className="shell__sidebar">
        <div className="shell__top">
          <Link to="/" className="shell__brand" title={rail ? t("app.name") : undefined}>
            <span className="shell__brand-name">
              <Icon name="logo" />
              <span className="shell__brand-text">{t("app.name")}</span>
            </span>
            {currentOrg === undefined ? null : (
              <span className="shell__org truncate" title={currentOrg.name}>
                {currentOrg.name}
              </span>
            )}
          </Link>
          <button
            type="button"
            className="shell__toggle"
            aria-label={toggleLabel}
            aria-expanded={!rail}
            aria-controls={sidebarId}
            aria-keyshortcuts={shortcut.aria}
            title={t("nav.sidebarHint", { shortcut: shortcut.label })}
            onClick={toggleSidebar}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <nav ref={navRef} className="shell__nav" aria-label={t("nav.label")}>
          <ul className="shell__nav-list">
            {items.map((item) => (
              <NavEntry
                key={item.to}
                item={item}
                rail={rail}
                permissions={permissions}
                onFlyoutChange={onFlyoutChange}
              />
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
