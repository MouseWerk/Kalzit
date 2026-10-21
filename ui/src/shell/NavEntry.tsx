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
  permissions: OrgPermissions;
  /** Tells the shell when a flyout opens or closes, so its shortcuts can tell it apart. */
  onFlyoutChange: (open: boolean) => void;
}

/** One entry of the main navigation: a link, or a link with expandable sub-pages. */
export function NavEntry({ item, rail, permissions, onFlyoutChange }: NavEntryProps) {
  const { t } = useI18n();
  const children = visibleChildren(item, permissions);
  if (children.length === 0) {
    return (
      <li>
        {/* The title is the tooltip when the rail or a phone shows only the icon. */}
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
    );
  }
  return (
    <NavGroup
      item={item}
      rail={rail}
      childItems={children}
      permissions={permissions}
      onFlyoutChange={onFlyoutChange}
    />
  );
}

function NavGroup({
  item,
  rail,
  childItems,
  onFlyoutChange,
}: NavEntryProps & { childItems: readonly NavChild[] }) {
  const { t } = useI18n();
  const pathname = useLocation({ select: (location) => location.pathname });
  const within = isWithin(pathname, item.to);
  const listId = useId();
  const label = t(item.label);
  const childrenLabel = t("nav.children", { name: label });

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

  const flyout = useFlyout(rail, onFlyoutChange);

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
        {/* The entry itself is current only on its own page; inside, the child is the page. */}
        <Link
          ref={flyout.linkRef}
          to={item.to}
          className="nav-link"
          title={label}
          activeOptions={{ exact: true }}
          aria-current={within && pathname !== item.to ? "true" : undefined}
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
            aria-controls={listId}
            aria-label={childrenLabel}
            title={childrenLabel}
            onClick={toggle}
          >
            <Icon name="chevron" className="nav-group__chevron" />
          </button>
        )}
      </div>
      {!rail && expanded ? (
        <ChildList id={listId} label={childrenLabel} childItems={childItems} />
      ) : null}
      {rail && flyout.open ? (
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
            <Link
              to={child.to}
              className="nav-link nav-link--child"
              title={t(child.label)}
              onClick={onNavigate}
            >
              <span className="nav-link__label">{t(child.label)}</span>
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

/**
 * The rail's flyout: opens on hover or keyboard focus, closes when both leave, on Escape (focus
 * goes back to the entry) and on a click outside. It is a layer, so Escape reaches it first.
 */
function useFlyout(rail: boolean, onFlyoutChange: (open: boolean) => void) {
  const [requested, setRequested] = useState(false);
  const open = rail && requested;
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
    setRequested(false);
    if (returnFocus && anchorRef.current?.contains(document.activeElement) === true) {
      returningFocus.current = true;
      linkRef.current?.focus();
      returningFocus.current = false;
    }
  }

  useEscapeLayer(open, () => close(true));

  const reportOpen = useEffectEvent((value: boolean) => onFlyoutChange(value));
  useEffect(() => {
    if (!open) {
      return;
    }
    reportOpen(true);
    return () => reportOpen(false);
  }, [open]);

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

  // Fixed to the window next to the rail, so the scrolling navigation does not clip it.
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
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
  }, [open]);

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
      cancelClose();
      setRequested(true);
    },
    onPointerLeave() {
      if (!rail) {
        return;
      }
      cancelClose();
      // Keyboard focus inside keeps it open.
      if (anchorRef.current?.contains(document.activeElement) === true) {
        return;
      }
      closeTimer.current = window.setTimeout(() => setRequested(false), FLYOUT_CLOSE_DELAY_MS);
    },
    onFocus() {
      if (!rail || returningFocus.current) {
        return;
      }
      cancelClose();
      setRequested(true);
    },
    onBlur(event: FocusEvent<HTMLLIElement>) {
      const next = event.relatedTarget;
      if (next instanceof Node && anchorRef.current?.contains(next) === true) {
        return;
      }
      cancelClose();
      setRequested(false);
    },
  };
}
