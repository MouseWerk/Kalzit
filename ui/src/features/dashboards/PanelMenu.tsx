import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useMenuButton } from "../../shell/useMenuButton";
import "./dashboardTools.css";

/** One entry of a panel's menu: an action, or a link (a data link of the panel). */
export interface PanelMenuItem {
  key: string;
  /** Shown in the menu. */
  label: string;
  /** The accessible name, naming the panel ("Edit “Orders”"). */
  name: string;
  onSelect?: () => void;
  href?: string;
  newTab?: boolean;
  disabled?: boolean;
}

/**
 * A panel's actions behind one icon button (docs/design/feel.md section 6), so narrow panels
 * keep a one-line title bar. The menu is drawn on top of the page, outside the card, which clips
 * its content; it follows the menu button pattern of the account menu (arrow keys, Home, End,
 * Escape and Tab close, focus returns to the button).
 */
export function PanelMenu({ title, items }: { title: string; items: readonly PanelMenuItem[] }) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;

  // Placed under the button, its right edge on the button's, in the window.
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (!open || button === null || list === null) {
      return;
    }
    const box = button.getBoundingClientRect();
    list.style.setProperty("--menu-top", `${box.bottom}px`);
    list.style.setProperty("--menu-right", `${window.innerWidth - box.right}px`);
  }, [open, buttonRef, menuRef]);

  // The menu stands in the window, under its button: scrolling or resizing closes it rather
  // than leave it behind.
  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => closeMenu(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, closeMenu]);

  // Tab leaves the menu back at its button (the menu is drawn at the end of the page, so the
  // browser would otherwise move on from there).
  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    menu.onMenuKeyDown(event);
  }

  // Clicks in the menu are the menu's: they neither start a panel drag nor count as outside.
  const keep = (event: PointerEvent) => {
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
  };

  return (
    <div className="menu-anchor panel-menu__anchor" ref={anchorRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--ghost button--small panel-menu__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("dashboards.panel.menuNamed", { title })}
        title={t("dashboards.panel.menu")}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={menu.toggle}
        onKeyDown={menu.onButtonKeyDown}
      >
        <Icon name="more" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={t("dashboards.panel.menuNamed", { title })}
              className="menu panel-menu"
              onKeyDown={onMenuKeyDown}
              onPointerDown={keep}
            >
              {items.map((item) =>
                item.href === undefined ? (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    className="menu__item"
                    aria-label={item.name}
                    disabled={item.disabled}
                    onClick={() => {
                      closeMenu(true);
                      item.onSelect?.();
                    }}
                  >
                    {item.label}
                  </button>
                ) : (
                  <a
                    key={item.key}
                    role="menuitem"
                    className="menu__item"
                    href={item.href}
                    aria-label={item.name}
                    onClick={() => closeMenu(false)}
                    {...(item.newTab === true
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    {item.label}
                  </a>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
