import { getRouteApi, Outlet } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useAppearanceSync } from "../appearance/api";
import { Icon } from "../components/Icon";
import { Toaster } from "../components/Toaster";
import { NAV_SECTIONS } from "../features/nav";
import { useI18n } from "../i18n/i18n";
import { openLayerCount } from "../lib/layers";
import { currentOrgOf, useOrgPermissions } from "../org/useOrg";
import { usePreferencesSync } from "../preferences/preferences";
import { markEntered } from "../preferences/startDashboard";
import { CommandPalette } from "./CommandPalette";
import { trackInputModality } from "./inputModality";
import { NavEntry } from "./NavEntry";
import type { NavItem } from "./navItem";
import { OrgSwitcher } from "./OrgSwitcher";
import { setOverlay, useOverlay } from "./overlay";
import { RailTooltip } from "./RailTooltip";
import { SetupChecklist } from "./SetupChecklist";
import {
  isHelpShortcut,
  isPaletteShortcut,
  isSearchShortcut,
  ShortcutsHelp,
} from "./ShortcutsHelp";
import { CrumbSlotContext, SidebarColumnContext } from "./shellContext";
import {
  isToggleShortcut,
  isTypingTarget,
  readCollapsed,
  useWideLayout,
  writeCollapsed,
} from "./sidebarState";
import { TopBar } from "./TopBar";
import { UserMenu } from "./UserMenu";
import "./shellUx.css";

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
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarId = useId();
  const permissions = useOrgPermissions();
  // Hidden by the permissions: an entry with `useGranted` may still show, from its own data.
  const sections = NAV_SECTIONS.map((section) =>
    section.filter(
      (item) => (item.visible?.(permissions) ?? true) || item.useGranted !== undefined,
    ),
  ).filter((section) => section.length > 0);
  const currentOrg = currentOrgOf(me);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const wide = useWideLayout();
  // Below the column breakpoint the sidebar is a bar on top; it has nothing to collapse.
  const rail = collapsed && wide;
  // A flyout opened from the keyboard is a layer for Escape, but not a dialog: F6 and Ctrl+B
  // still work while it is open.
  const openFlyouts = useRef(0);
  const overlay = useOverlay();
  // Signing out leaves the shell; nothing of it stays open for the next session.
  useEffect(() => {
    markEntered(true);
    return () => {
      setOverlay(null);
      markEntered(false);
    };
  }, []);
  usePreferencesSync(me.id);
  useAppearanceSync(currentOrgOf(me)?.id);

  function onFlyoutLayerChange(open: boolean) {
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
    // The palette opens from anywhere, also from a text field or code editor; a second Ctrl+K
    // closes it. Over a dialog (which keeps the focus to itself) it does nothing at all, so the
    // key is left to the browser.
    if (isPaletteShortcut(event)) {
      if (event.defaultPrevented || (overlay !== "palette" && blockingLayers())) {
        return;
      }
      event.preventDefault();
      setOverlay(overlay === "palette" ? null : "palette");
      return;
    }
    // "/" searches, as in most tools; only where it would not type a slash.
    if (isSearchShortcut(event)) {
      if (event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      setOverlay("palette");
      return;
    }
    if (isHelpShortcut(event)) {
      if (event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      setOverlay("shortcuts");
      return;
    }
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
    trackInputModality();
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // A button rather than a "#main" link: a hash link would add an entry to the router's history.
  function skipToContent() {
    mainRef.current?.focus();
  }

  // Set from a ref callback, so breadcrumbs move into the header before the first paint.
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="shell" data-sidebar={rail ? "collapsed" : "expanded"}>
      <button type="button" className="skip-link" onClick={skipToContent}>
        {t("common.skipToContent")}
      </button>
      <header ref={sidebarRef} id={sidebarId} className="shell__sidebar">
        <div className="shell__top">
          <OrgSwitcher me={me} rail={rail} />
        </div>
        <nav ref={navRef} className="shell__nav" aria-label={t("nav.label")}>
          {sections.map((section, index) => (
            <NavSection
              key={section[0]?.to ?? index}
              first={index === 0}
              items={section}
              rail={rail}
              wide={wide}
              permissions={permissions}
              onFlyoutLayerChange={onFlyoutLayerChange}
            />
          ))}
        </nav>
        {currentOrg === undefined || rail || !wide ? null : (
          <SetupChecklist
            key={`${me.id}:${currentOrg.id}`}
            userId={me.id}
            orgId={currentOrg.id}
            placement="sidebar"
          />
        )}
        <UserMenu me={me} rail={rail} />
        <RailTooltip rail={rail} sidebarRef={sidebarRef} />
      </header>
      <main ref={mainRef} id="main" className="shell__main" tabIndex={-1}>
        {/*
          The top bar: the sidebar toggle and the page's breadcrumbs (Breadcrumbs portals them
          in) on the left, search, New and Help on the right.
        */}
        <TopBar
          wide={wide}
          rail={rail}
          sidebarId={sidebarId}
          onToggleSidebar={toggleSidebar}
          crumbSlot={setCrumbSlot}
        />
        <div className="shell__content">
          <CrumbSlotContext value={crumbSlot}>
            <SidebarColumnContext value={wide && !rail}>
              <Outlet />
            </SidebarColumnContext>
          </CrumbSlotContext>
        </div>
      </main>
      <Toaster />
      {overlay === "palette" ? (
        <CommandPalette
          onClose={() => setOverlay(null)}
          onShowShortcuts={() => setOverlay("shortcuts")}
        />
      ) : null}
      {overlay === "shortcuts" ? <ShortcutsHelp onClose={() => setOverlay(null)} /> : null}
    </div>
  );
}

/** One group of the navigation, set apart from the one before by a thin divider. */
function NavSection({
  first,
  items,
  ...entry
}: Omit<ComponentProps<typeof NavEntry>, "item"> & {
  first: boolean;
  items: readonly NavItem[];
}) {
  return (
    <>
      {first ? null : <hr className="shell__divider" />}
      <ul className="shell__nav-list">
        {items.map((item) =>
          (item.visible?.(entry.permissions) ?? true) || item.useGranted === undefined ? (
            <NavEntry key={item.to} item={item} {...entry} />
          ) : (
            <GrantedNavEntry key={item.to} useGranted={item.useGranted} item={item} {...entry} />
          ),
        )}
      </ul>
    </>
  );
}

/** An entry the permissions hide, shown when its area's hook finds a grant. */
function GrantedNavEntry({
  useGranted,
  ...entry
}: ComponentProps<typeof NavEntry> & { useGranted: () => boolean }) {
  const granted = useGranted();
  return granted ? <NavEntry {...entry} /> : null;
}
