import { getRouteApi, Outlet, useRouterState } from "@tanstack/react-router";
import {
  type ComponentProps,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useAppearanceSync } from "../appearance/api";
import { Toaster } from "../components/Toaster";
import { NAV_SECTIONS } from "../features/nav";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { openLayerCount } from "../lib/layers";
import { useBackGuard } from "../lib/useBackGuard";
import { isOpenWhileGated, OrgGatePage, useOrgGate } from "../org/OrgGate";
import { currentOrgOf, useOrgPermissions } from "../org/useOrg";
import { usePreferencesSync } from "../preferences/preferences";
import { markEntered } from "../preferences/startDashboard";
import { AppsSection } from "./AppsSection";
import { CommandPalette } from "./CommandPalette";
import { trackInputModality } from "./inputModality";
import { NavEntry } from "./NavEntry";
import type { NavItem } from "./navItem";
import { OrgSwitcher } from "./OrgSwitcher";
import { setOverlay, useOverlay } from "./overlay";
import { PinnedSection, RailPins } from "./PinnedSection";
import { RailTooltip } from "./RailTooltip";
import { SetupChecklist } from "./SetupChecklist";
import {
  isHelpShortcut,
  isPaletteShortcut,
  isSearchShortcut,
  ShortcutsHelp,
} from "./ShortcutsHelp";
import { SidebarResizer } from "./SidebarResizer";
import { CrumbSlotContext, SidebarColumnContext } from "./shellContext";
import { withSidebarMotion } from "./sidebarMotion";
import {
  isFocusShortcut,
  isToggleShortcut,
  isTypingTarget,
  readCollapsed,
  readFocus,
  readWidth,
  useWideLayout,
  writeCollapsed,
  writeFocus,
  writeWidth,
} from "./sidebarState";
import { TopBar } from "./TopBar";
import { UserMenu } from "./UserMenu";
import { useSidebarPeek } from "./useSidebarPeek";
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
  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        (item.visible?.(permissions) ?? true) ||
        item.useGranted !== undefined ||
        (item.fallback?.visible?.(permissions) ?? false),
    ),
  })).filter((section) => section.items.length > 0);
  const currentOrg = currentOrgOf(me);
  // The current organization's sign-in rules may refuse this session (a second factor it
  // requires, a sign-in through its provider): its pages give way to a page that says so.
  const gate = useOrgGate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const gated = gate !== undefined && currentOrg !== undefined && !isOpenWhileGated(pathname);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // While signing out the page is taken off screen, with everything it polls or streams.
  const [leaving, setLeaving] = useState(false);
  // Focus mode hides the sidebar completely; it peeks in from the window's edge.
  const [focusMode, setFocusMode] = useState(readFocus);
  // The column's width from dragging its edge; undefined is the default token.
  const [width, setWidth] = useState(readWidth);
  const shellRef = useRef<HTMLDivElement>(null);
  // The remembered width as the column's custom property (the edge's drag previews it there too).
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (shell === null) return;
    if (width === undefined) {
      shell.style.removeProperty("--sidebar-width");
    } else {
      shell.style.setProperty("--sidebar-width", `${width}px`);
    }
  }, [width]);
  const wide = useWideLayout();
  // Below the column breakpoint the sidebar is a bar on top; it has nothing to collapse or hide.
  const hidden = focusMode && wide;
  const railColumn = collapsed && wide && !hidden;
  // Focus mode hides the closed peek: focus inside it would be lost, so it goes to the page.
  const peek = useSidebarPeek(railColumn || hidden, sidebarRef, pathname, () => {
    if (hidden) mainRef.current?.focus();
  });
  // What the sidebar shows: the rail's icons, or the full sidebar (also while it peeks over the
  // page from the rail or from the window's edge).
  const rail = railColumn && peek.state === "closed";
  const layout = hidden ? "hidden" : railColumn ? "rail" : "column";
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
  // The browser's or mouse's Back button closes an open overlay (with the dialogs' guards, the
  // topmost layer answers) rather than leaving it over the page.
  useBackGuard(overlay !== null, {
    onClose: () => setOverlay(null),
    hasInput: () => false,
    onKept: () => {},
  });
  usePreferencesSync(me.id);
  useAppearanceSync(currentOrgOf(me)?.id);

  function onFlyoutLayerChange(open: boolean) {
    openFlyouts.current += open ? 1 : -1;
  }

  function blockingLayers(): boolean {
    return openLayerCount() - openFlyouts.current > 0;
  }

  function toggleFocusMode() {
    // Below the column breakpoint the sidebar is a bar on top: nothing to hide, nothing to keep.
    if (!wide) return;
    withSidebarMotion(() =>
      flushSync(() =>
        setFocusMode((current) => {
          writeFocus(!current);
          return !current;
        }),
      ),
    );
  }

  function toggleSidebar() {
    // In focus mode the toggle brings the sidebar back first.
    if (hidden) {
      toggleFocusMode();
      return;
    }
    // The edge glides instead of jumping; the update is synchronous so the transition's
    // second snapshot shows the new state. It runs a frame later, after the first snapshot, so
    // it flips the state it finds rather than the one rendered when the key was pressed: two
    // quick toggles are two flips.
    withSidebarMotion(() =>
      flushSync(() =>
        setCollapsed((current) => {
          writeCollapsed(!current);
          return !current;
        }),
      ),
    );
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    // The palette opens from anywhere, also from a text field or code editor; a second Ctrl+K
    // closes it. Over a dialog (which keeps the focus to itself) it does nothing at all, so the
    // key is left to the browser.
    if (isPaletteShortcut(event)) {
      if (inKiosk() || event.defaultPrevented || (overlay !== "palette" && blockingLayers())) {
        return;
      }
      event.preventDefault();
      // A held key repeats; the palette must not flicker open and shut.
      if (!event.repeat) {
        setOverlay(overlay === "palette" ? null : "palette");
      }
      return;
    }
    // "/" searches, as in most tools; only where it would not type a slash.
    if (isSearchShortcut(event)) {
      if (inKiosk() || event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        setOverlay("palette");
      }
      return;
    }
    // "?" opens the help and closes it again; in its search field it is typed.
    if (isHelpShortcut(event)) {
      const open = overlay === "shortcuts";
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        (!open && blockingLayers()) ||
        (open && openLayerCount() > 1)
      ) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        setOverlay(open ? null : "shortcuts");
      }
      return;
    }
    if (isFocusShortcut(event)) {
      if (!wide || event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        toggleFocusMode();
      }
      return;
    }
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      peek.state === "open" &&
      !event.defaultPrevented &&
      !blockingLayers() &&
      sidebarRef.current?.querySelector('[aria-expanded="true"][aria-haspopup]') == null
    ) {
      event.preventDefault();
      peek.close(0, true);
      return;
    }
    if (isToggleShortcut(event)) {
      if (!wide || event.defaultPrevented || isTypingTarget(event.target) || blockingLayers()) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        toggleSidebar();
      }
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
    // The regions F6 cycles through: navigation, content and, while a notification shows, the
    // notifications (so Undo is reachable in time). From anywhere else (the account menu
    // button) focus goes to the navigation first. With two regions both directions land on the
    // other one.
    // The toast with Undo comes first, then the others (an error stays until dismissed).
    const toasts = [...document.querySelectorAll<HTMLElement>(".toaster .toast")].sort(
      (a, b) => Number(b.hasAttribute("data-undo")) - Number(a.hasAttribute("data-undo")),
    );
    // In focus mode the navigation is out of the window: it peeks in to take the focus.
    if (hidden && peek.state !== "open") {
      flushSync(() => peek.open(0));
    }
    const stops: HTMLElement[] = [nav, main, ...toasts];
    const active = document.activeElement;
    const at = stops.findIndex((stop) => stop.contains(active));
    if (at === -1) {
      focusNav(nav);
      return;
    }
    const step = event.shiftKey ? -1 : 1;
    const next = stops[(at + step + stops.length) % stops.length];
    if (next === nav) {
      focusNav(nav);
    } else if (next === main) {
      main.focus();
    } else {
      next?.querySelector<HTMLElement>("button")?.focus();
    }
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
    <div
      ref={shellRef}
      className="shell"
      data-sidebar={rail ? "collapsed" : "expanded"}
      data-layout={layout}
      data-peek={peek.state === "closed" ? undefined : peek.state}
    >
      <button type="button" className="skip-link" onClick={skipToContent}>
        {t("common.skipToContent")}
      </button>
      {/* In focus mode, resting the pointer on the window's edge brings the sidebar in;
          before the sidebar, so the sidebar covers it once it is in. */}
      {hidden ? (
        <div
          className="shell__edge"
          aria-hidden="true"
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") peek.open();
          }}
          onPointerLeave={() => peek.close()}
        />
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hovering peeks as a pointer shortcut; F6 brings the keyboard there */}
      <header
        ref={sidebarRef}
        id={sidebarId}
        className="shell__sidebar"
        // Touch has no hover: a tap on the rail opens its links, not the peek.
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") peek.open();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") peek.close();
        }}
        onBlur={(event) => {
          if (peek.state === "open" && !event.currentTarget.contains(event.relatedTarget)) {
            peek.close();
          }
        }}
        // Only the closing slide itself ends the closing state, not a shadow or colour change.
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "translate") {
            peek.settle();
          }
        }}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === "kz-peek-out") {
            peek.settle();
          }
        }}
      >
        <div className="shell__top">
          <OrgSwitcher me={me} rail={rail} />
        </div>
        <nav ref={navRef} className="shell__nav" aria-label={t("nav.label")}>
          {sections.map((section, index) => (
            <NavSection
              // By place, not by first entry: an entry the permissions show later must not remount it.
              // biome-ignore lint/suspicious/noArrayIndexKey: the groups are a fixed list in a fixed order
              key={index}
              first={index === 0}
              heading={rail || !wide ? undefined : section.heading}
              items={section.items}
              rail={rail}
              wide={wide}
              permissions={permissions}
              onFlyoutLayerChange={onFlyoutLayerChange}
            />
          ))}
          {currentOrg === undefined ? null : (
            <AppsSection key={currentOrg.id} orgId={currentOrg.id} heading={!rail && wide} />
          )}
          {/* The pins need room for their titles: the column, not the rail or the bar on top. */}
          {currentOrg === undefined || rail || !wide ? null : (
            <>
              <hr className="shell__divider" />
              <PinnedSection key={currentOrg.id} orgId={currentOrg.id} />
            </>
          )}
          {currentOrg !== undefined && rail ? (
            <RailPins key={`pins:${currentOrg.id}`} orgId={currentOrg.id} />
          ) : null}
        </nav>
        {currentOrg === undefined || rail || !wide ? null : (
          <SetupChecklist
            key={`${me.id}:${currentOrg.id}`}
            userId={me.id}
            orgId={currentOrg.id}
            placement="sidebar"
          />
        )}
        <UserMenu me={me} rail={rail} onLeaving={setLeaving} />
        {layout === "column" && wide ? (
          <SidebarResizer
            shellRef={shellRef}
            sidebarRef={sidebarRef}
            sidebarId={sidebarId}
            width={width}
            onCommit={(next) => {
              setWidth(next);
              writeWidth(next);
            }}
            onCollapse={toggleSidebar}
            onHide={toggleFocusMode}
          />
        ) : null}
        <RailTooltip rail={rail} sidebarRef={sidebarRef} />
      </header>
      <main ref={mainRef} id="main" className="shell__main" tabIndex={-1}>
        {/*
          The top bar: the sidebar toggle and the page's breadcrumbs (Breadcrumbs portals them
          in) on the left, search, New and Help on the right.
        */}
        <TopBar
          wide={wide}
          rail={layout !== "column"}
          sidebarId={sidebarId}
          onToggleSidebar={toggleSidebar}
          crumbSlot={setCrumbSlot}
        />
        <div className="shell__content">
          <CrumbSlotContext value={crumbSlot}>
            <SidebarColumnContext value={wide && layout === "column"}>
              {leaving ? (
                // Quietly in place of the page while the session ends.
                <p className="loading" role="status">
                  {t("userMenu.signingOut")}
                </p>
              ) : gated ? (
                <OrgGatePage code={gate} orgName={currentOrg.name} />
              ) : (
                <Outlet />
              )}
            </SidebarColumnContext>
          </CrumbSlotContext>
        </div>
      </main>
      <Toaster />
      {overlay === "palette" ? (
        <CommandPalette
          onClose={() => setOverlay(null)}
          onShowShortcuts={() => setOverlay("shortcuts")}
          focusMode={wide ? focusMode : undefined}
          onToggleFocusMode={() => {
            setOverlay(null);
            toggleFocusMode();
          }}
        />
      ) : null}
      {overlay === "shortcuts" ? <ShortcutsHelp onClose={() => setOverlay(null)} /> : null}
    </div>
  );
}

/**
 * Kiosk and TV mode cover the app for a screen nobody sits at: only Escape (to leave) and the
 * help overlay work there; search and the command palette stay shut.
 */
function inKiosk(): boolean {
  return document.querySelector(".dashboard--kiosk") !== null;
}

/** The current page, else the entry it lies in (the rail hides sub-pages), else the first. */
function focusNav(nav: HTMLElement): void {
  const current =
    nav.querySelector<HTMLElement>('[aria-current="page"]') ??
    nav.querySelector<HTMLElement>('[aria-current="true"]');
  (current ?? nav.querySelector<HTMLElement>("a"))?.focus();
}

/**
 * One group of the navigation, set apart from the one before by a thin divider, and named by a
 * small heading where it has one (the organization group, in the column).
 */
function NavSection({
  first,
  heading,
  items,
  ...entry
}: Omit<ComponentProps<typeof NavEntry>, "item"> & {
  first: boolean;
  heading: MessageKey | undefined;
  items: readonly NavItem[];
}) {
  const { t } = useI18n();
  const headingId = useId();
  return (
    <>
      {first ? null : <hr className="shell__divider" />}
      {heading === undefined ? null : (
        <h2 id={headingId} className="shell__group-heading">
          {t(heading)}
        </h2>
      )}
      <ul
        className="shell__nav-list"
        aria-labelledby={heading === undefined ? undefined : headingId}
      >
        {items.map((item) =>
          (item.visible?.(entry.permissions) ?? true) ? (
            <NavEntry key={item.to} item={item} {...entry} />
          ) : (
            <GrantedNavEntry key={item.to} useGranted={item.useGranted} item={item} {...entry} />
          ),
        )}
      </ul>
    </>
  );
}

/**
 * An entry the permissions hide, shown when its area's hook finds a grant; otherwise its
 * fallback, when the permissions show that.
 */
function GrantedNavEntry({
  useGranted = notGranted,
  ...entry
}: ComponentProps<typeof NavEntry> & { useGranted: (() => boolean) | undefined }) {
  const granted = useGranted();
  if (granted) {
    return <NavEntry {...entry} />;
  }
  const fallback = entry.item.fallback;
  return fallback !== undefined && (fallback.visible?.(entry.permissions) ?? true) ? (
    <NavEntry {...entry} item={fallback} />
  ) : null;
}

const notGranted = () => false;
