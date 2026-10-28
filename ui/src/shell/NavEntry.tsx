import { Link, useLocation } from "@tanstack/react-router";
import {
  type FocusEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { useEscapeLayer } from "../lib/layers";
import type { OrgPermissions } from "../org/useOrg";
import { lastInputWasKeyboard } from "./inputModality";
import { groupChildren, isWithin, type NavChild, type NavItem, visibleChildren } from "./navItem";
import { readGroupExpanded, writeGroupExpanded } from "./sidebarState";

/** How long the rail's flyout stays after the pointer left, so it can cross the gap. */
const FLYOUT_CLOSE_DELAY_MS = 150;
/** Gap between the rail and its flyout, and the flyout's distance from the window edges. */
const FLYOUT_GAP_PX = 4;

interface NavEntryProps {
  item: NavItem;
  /** True while the sidebar is the icon rail: children open in a flyout instead of a list. */
  rail: boolean;
  /** True while the sidebar is a column; below, it is a bar on top that may show only icons. */
  wide: boolean;
  permissions: OrgPermissions;
  /** Tells the shell when a flyout layer opens or closes, so its shortcuts can tell it apart. */
  onFlyoutLayerChange: (open: boolean) => void;
}

/** One entry of the main navigation: a link, or a link with expandable sub-pages. */
export function NavEntry({ item, rail, wide, permissions, onFlyoutLayerChange }: NavEntryProps) {
  const { t } = useI18n();
  const children = visibleChildren(item, permissions);
  if (children.length === 0) {
    const label = item.badge === undefined ? t(item.label) : `${t(item.label)} ${t(item.badge)}`;
    return (
      <li>
        {/* A tooltip only where the label is hidden: the rail, and phones (narrow layout). */}
        <Link
          to={item.to}
          className="nav-link"
          title={rail || !wide ? label : undefined}
          activeOptions={{ exact: item.exact === true }}
        >
          <Icon name={item.icon} />
          <span className="nav-link__label">
            {item.badge === undefined ? (
              label
            ) : (
              <>
                {t(item.label)} <span className="nav-link__badge">{t(item.badge)}</span>
              </>
            )}
          </span>
        </Link>
      </li>
    );
  }
  return (
    <NavGroup
      item={item}
      rail={rail}
      wide={wide}
      childItems={children}
      permissions={permissions}
      onFlyoutLayerChange={onFlyoutLayerChange}
    />
  );
}

function NavGroup({
  item,
  rail,
  wide,
  childItems,
  onFlyoutLayerChange,
}: NavEntryProps & { childItems: readonly NavChild[] }) {
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const within =
    isWithin(pathname, item.to) && !(item.outside ?? []).some((path) => isWithin(pathname, path));
  const listId = useId();
  const label = t(item.label);
  const childrenLabel =
    item.childrenLabel === undefined ? t("nav.children", { name: label }) : t(item.childrenLabel);

  // Open while the current page is inside the group; otherwise as the user left it.
  const [expanded, setExpanded] = useState(() => within || readGroupExpanded(item.to) === true);
  const [wasWithin, setWasWithin] = useState(within);
  if (within !== wasWithin) {
    setWasWithin(within);
    if (within) {
      setExpanded(true);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    writeGroupExpanded(item.to, next);
  }

  const flyout = useFlyout(rail, onFlyoutLayerChange);
  // The bar on top has no chevrons, so the current group's sub-pages always show there.
  const listShown = !rail && (expanded || (within && !wide));
  // The entry is the page only on its own path; inside, it is marked while its child is hidden.
  const current = within && pathname !== item.to && !listShown ? "true" : undefined;

  return (
    <li
      ref={flyout.anchorRef}
      className="nav-group"
      data-within={within ? "" : undefined}
      onPointerEnter={flyout.onPointerEnter}
      onPointerLeave={flyout.onPointerLeave}
      onFocus={flyout.onFocus}
      onBlur={flyout.onBlur}
    >
      <div className="nav-group__row">
        <Link
          ref={flyout.linkRef}
          to={item.to}
          className={within && listShown ? "nav-link nav-link--within" : "nav-link"}
          title={rail || !wide ? label : undefined}
          activeOptions={{ exact: true }}
          aria-current={current}
          aria-expanded={rail ? flyout.open : undefined}
          onClick={() => flyout.close(false)}
        >
          <Icon name={item.icon} />
          <span className="nav-link__label">{label}</span>
        </Link>
        {rail ? null : (
          <button
            type="button"
            className="nav-group__toggle"
            aria-expanded={expanded}
            aria-controls={listShown ? listId : undefined}
            aria-label={childrenLabel}
            title={childrenLabel}
            onClick={toggle}
          >
            <Icon name="chevron" className="nav-group__chevron" />
          </button>
        )}
      </div>
      {listShown ? <ChildList id={listId} label={childrenLabel} childItems={childItems} /> : null}
      {flyout.open ? (
        <div ref={flyout.panelRef} className="nav-flyout">
          <p className="nav-flyout__title" aria-hidden="true">
            {label}
          </p>
          <ChildList
            label={childrenLabel}
            childItems={childItems}
            onNavigate={() => flyout.close(false)}
          />
        </div>
      ) : null}
    </li>
  );
}

function ChildList({
  id,
  label,
  childItems,
  onNavigate,
}: {
  id?: string;
  label: string;
  childItems: readonly NavChild[];
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const baseId = useId();
  return (
    <ul id={id} className="nav-sub" aria-label={label}>
      {groupChildren(childItems).map(({ group, children }, index) => {
        const links = children.map((child) => (
          <li key={child.to}>
            <Link to={child.to} className="nav-sublink" onClick={onNavigate}>
              <span className="nav-sublink__label">{t(child.label)}</span>
            </Link>
          </li>
        ));
        if (group === undefined) {
          return links;
        }
        const headingId = `${baseId}-${index}`;
        return (
          <li key={group} className="nav-sub__group">
            <span id={headingId} className="nav-sub__title">
              {t(group)}
            </span>
            <ul className="nav-sub__list" aria-labelledby={headingId}>
              {links}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

/** How the flyout was opened: a hover is a preview, keyboard focus makes it a layer. */
type FlyoutMode = "hover" | "layer";

/**
 * The rail's flyout: opens on hover or focus, closes when both leave and on a click outside.
 * Opened from the keyboard it is a layer, so Escape closes it (and focus goes back to the
 * entry); a hover preview does not take Escape away from the page.
 */
function useFlyout(rail: boolean, onLayerChange: (open: boolean) => void) {
  const [mode, setMode] = useState<FlyoutMode | null>(null);
  // Leaving the rail forgets the flyout, so it does not come back when the rail returns.
  const [wasRail, setWasRail] = useState(rail);
  if (rail !== wasRail) {
    setWasRail(rail);
    if (!rail) {
      setMode(null);
    }
  }
  const open = rail && mode !== null;
  const layer = rail && mode === "layer";
  const anchorRef = useRef<HTMLLIElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  // Set while focus is moved back to the entry on Escape, so that focus does not reopen it.
  const returningFocus = useRef(false);

  function cancelClose() {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }

  function close(returnFocus: boolean) {
    cancelClose();
    setMode(null);
    if (returnFocus && anchorRef.current?.contains(document.activeElement) === true) {
      returningFocus.current = true;
      linkRef.current?.focus();
      returningFocus.current = false;
    }
  }

  useEscapeLayer(layer, () => close(true));

  const reportLayer = useEffectEvent((value: boolean) => onLayerChange(value));
  useEffect(() => {
    if (!layer) {
      return;
    }
    reportLayer(true);
    return () => reportLayer(false);
  }, [layer]);

  // A hover preview is no layer, yet Escape must dismiss it too (WCAG 1.4.13). It listens in the
  // bubble phase and leaves the key alone, so the page still gets its Escape.
  const hoverOpen = open && !layer;
  useEffect(() => {
    if (!hoverOpen) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
        window.clearTimeout(closeTimer.current);
        setMode(null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hoverOpen]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    if (event.target instanceof Node && anchorRef.current?.contains(event.target) !== true) {
      close(false);
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const listener = (event: PointerEvent) => onOutsidePointer(event);
    document.addEventListener("pointerdown", listener);
    return () => document.removeEventListener("pointerdown", listener);
  }, [open]);

  // Fixed to the window next to the rail, so the scrolling navigation does not clip it; placed
  // again when the window changes size.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    function place() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (anchor === null || panel === null) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const sidebar = anchor.closest(".shell__sidebar")?.getBoundingClientRect() ?? rect;
      const height = panel.getBoundingClientRect().height;
      const maxTop = window.innerHeight - height - FLYOUT_GAP_PX;
      panel.style.top = `${Math.max(FLYOUT_GAP_PX, Math.min(rect.top, maxTop))}px`;
      panel.style.left = `${sidebar.right + FLYOUT_GAP_PX}px`;
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  function openAs(next: FlyoutMode) {
    cancelClose();
    // A hover never downgrades a flyout the keyboard opened.
    setMode((previous) => (previous === "layer" ? "layer" : next));
  }

  return {
    open,
    anchorRef,
    linkRef,
    panelRef,
    close,
    onPointerEnter(event: { pointerType: string }) {
      if (!rail || event.pointerType === "touch") {
        return;
      }
      openAs("hover");
    },
    onPointerLeave() {
      if (!rail) {
        return;
      }
      cancelClose();
      // Focus inside keeps it open.
      if (anchorRef.current?.contains(document.activeElement) === true) {
        return;
      }
      closeTimer.current = window.setTimeout(() => setMode(null), FLYOUT_CLOSE_DELAY_MS);
    },
    onFocus() {
      if (!rail || returningFocus.current) {
        return;
      }
      openAs(lastInputWasKeyboard() ? "layer" : "hover");
    },
    onBlur(event: FocusEvent<HTMLLIElement>) {
      const next = event.relatedTarget;
      if (next instanceof Node && anchorRef.current?.contains(next) === true) {
        return;
      }
      cancelClose();
      setMode(null);
    },
  };
}
