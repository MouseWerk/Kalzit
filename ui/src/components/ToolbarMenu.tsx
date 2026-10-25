import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFloatingMenu } from "../shell/useFloatingMenu";
import { useMenuButton } from "../shell/useMenuButton";
import { Icon, type IconName } from "./Icon";
import { type ShortcutKeys, WithTooltip } from "./IconButton";
import "../shell/shellUx.css";
import "./iconButton.css";

/** One entry of a toolbar menu. */
export type ToolbarMenuEntry =
  | {
      kind?: "action";
      key: string;
      label: string;
      icon?: IconName | undefined;
      onSelect: () => void;
      /** Deletes or discards: the label in the danger text color. */
      danger?: boolean | undefined;
      disabled?: boolean | undefined;
      /** Shown at the end of the item: "t ←". */
      shortcut?: string | undefined;
    }
  | { kind: "radio"; key: string; label: string; checked: boolean; onSelect: () => void }
  | { kind: "separator"; key: string }
  | { kind: "heading"; key: string; label: string };

interface ToolbarMenuProps {
  /** The button's accessible name and tooltip. */
  label: string;
  icon: IconName;
  /** Text next to the icon, as on the refresh interval button. */
  text?: ReactNode;
  entries: readonly ToolbarMenuEntry[];
  shortcut?: ShortcutKeys | undefined;
  className?: string | undefined;
}

/**
 * A quiet icon button that opens a menu, after the menu button pattern: arrow keys, Home and End
 * move, Escape and Tab close, focus returns to the button after a choice. The menu is drawn in
 * the window under the button (above it near the bottom edge), so a toolbar that wraps or
 * scrolls never clips it.
 */
export function ToolbarMenu({ label, icon, text, entries, shortcut, className }: ToolbarMenuProps) {
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const onMenuKeyDown = useFloatingMenu(menu);

  return (
    <div className="menu-anchor toolbar-menu" ref={anchorRef}>
      <WithTooltip label={label} shortcut={shortcut}>
        <button
          ref={buttonRef}
          type="button"
          className={
            className === undefined
              ? "button button--ghost icon-button"
              : `button button--ghost icon-button ${className}`
          }
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={label}
          onClick={menu.toggle}
          onKeyDown={menu.onButtonKeyDown}
        >
          <Icon name={icon} />
          {text === undefined ? null : <span className="icon-button__text">{text}</span>}
        </button>
      </WithTooltip>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={label}
              className="menu toolbar-menu__list"
              onKeyDown={onMenuKeyDown}
            >
              {entries.map((entry) => {
                switch (entry.kind) {
                  case "separator":
                    return <hr key={entry.key} className="toolbar-menu__separator" />;
                  case "heading":
                    return (
                      <div key={entry.key} className="menu__label" role="presentation">
                        {entry.label}
                      </div>
                    );
                  case "radio":
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        role="menuitemradio"
                        aria-checked={entry.checked}
                        className="menu__item"
                        onClick={() => {
                          closeMenu(true);
                          entry.onSelect();
                        }}
                      >
                        <span className="toolbar-menu__check" aria-hidden="true">
                          {entry.checked ? <Icon name="check" /> : null}
                        </span>
                        {entry.label}
                      </button>
                    );
                  default:
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        role="menuitem"
                        className={
                          entry.danger === true
                            ? "menu__item toolbar-menu__item--danger"
                            : "menu__item"
                        }
                        disabled={entry.disabled}
                        onClick={() => {
                          closeMenu(true);
                          entry.onSelect();
                        }}
                      >
                        {entry.icon === undefined ? (
                          <span className="toolbar-menu__check" aria-hidden="true" />
                        ) : (
                          <Icon name={entry.icon} />
                        )}
                        <span className="toolbar-menu__label">{entry.label}</span>
                        {entry.shortcut === undefined ? null : (
                          <kbd className="kbd toolbar-menu__key">{entry.shortcut}</kbd>
                        )}
                      </button>
                    );
                }
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
