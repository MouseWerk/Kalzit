import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useMenuButton } from "../../shell/useMenuButton";
import type { VariableOption } from "./api";
import { useMenuPlacement } from "./menuPlacement";
import "../../components/iconButton.css";
import "../../shell/shellUx.css";
import "./dashboardTools.css";
import "./toolbar.css";

/** More options than this get a search field in the menu. */
const SEARCH_FROM = 8;

/**
 * What the picker shows for the chosen values: "All", "North", or "North, East +2". When the
 * list is cut short the picked values are not all there is, so "All" is never claimed and a pick
 * of every listed value reads as a count.
 */
export function multiSummary(
  picked: readonly string[],
  list: readonly VariableOption[],
  truncated: boolean,
  text: {
    all: string;
    none: string;
    more: (count: number) => string;
    count: (count: number) => string;
  },
): string {
  if (picked.length === 0) {
    return text.none;
  }
  const labels = picked.map((value) => list.find((o) => o.value === value)?.label ?? value);
  if (list.length > 1 && list.every((o) => picked.includes(o.value))) {
    return truncated ? text.count(picked.length) : text.all;
  }
  const shown = labels.slice(0, 2).join(", ");
  return labels.length > 2 ? `${shown} ${text.more(labels.length - 2)}` : shown;
}

/**
 * The picker of a multi-value variable: a button in the look of the single-value select (value
 * summary, chevron) that opens a menu of checkboxes, with "Select all", "None" and, for a long
 * list, a search that has the focus on opening. The menu stays open while values are toggled;
 * Escape closes it and returns focus to the button.
 */
export function VariableMultiSelect({
  id,
  label,
  picked,
  options,
  truncated,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  picked: readonly string[];
  options: readonly VariableOption[];
  truncated: boolean;
  describedBy?: string | undefined;
  onChange: (values: string[]) => void;
}) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Values the options no longer list (a stored value, a value set by a click) stay choosable.
  const unknown = picked.filter((v) => !options.some((o) => o.value === v));
  const all: VariableOption[] = [...unknown.map((value) => ({ value, label: value })), ...options];
  const searchable = all.length > SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? all
      : all.filter(
          (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
        );
  const summary = multiSummary(picked, options, truncated, {
    all: t("dashboards.variables.all"),
    none: t("dashboards.variables.none"),
    more: (count) => t("dashboards.variables.more", { count }),
    count: (count) => t("dashboards.variables.count", { count }),
  });

  function toggle(value: string) {
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    // Keep the options' order, not the order of clicking.
    const order = all.map((o) => o.value);
    onChange(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  }

  useMenuPlacement(open, buttonRef, menuRef, () => closeMenu(false), [shown.length, query]);

  // Opening a searchable menu puts the focus in the search; Down leads on to the entries.
  useEffect(() => {
    if (open && searchable) {
      searchRef.current?.focus();
    }
  }, [open, searchable]);

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Home, End and Up stay the field's: the caret moves, the menu's entries are not skipped to.
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowUp") {
      event.stopPropagation();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Up from the first entry goes back to the search.
    if (event.key === "ArrowUp" && searchable) {
      const first = menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]');
      if (first !== null && document.activeElement === first) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
    }
    menu.onMenuKeyDown(event);
  }

  return (
    <div className="menu-anchor variables__anchor" ref={anchorRef}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className="variables__picker"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("dashboards.variables.picker", { label, value: summary })}
        aria-describedby={describedBy}
        onClick={() => {
          setQuery("");
          menu.toggle();
        }}
        onKeyDown={menu.onButtonKeyDown}
      >
        <span className="variables__summary">{summary}</span>
        <Icon name="chevronDown" className="variables__chevron" />
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/useSemanticElements: a popup of a search and a menu, not a field set
            <div
              ref={menuRef}
              role="group"
              aria-label={label}
              className="menu variables__menu"
              onKeyDown={onMenuKeyDown}
              // A click in the menu is the menu's, not a click outside that closes it.
              onPointerDown={(event) => event.stopPropagation()}
            >
              {searchable ? (
                <input
                  ref={searchRef}
                  type="search"
                  className="input variables__search"
                  value={query}
                  placeholder={t("dashboards.variables.search")}
                  aria-label={t("dashboards.variables.search")}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={onSearchKeyDown}
                />
              ) : null}
              <div id={menuId} role="menu" aria-label={label} className="variables__options">
                {/* biome-ignore lint/a11y/useSemanticElements: a group of menu items, not a field set */}
                <div
                  role="group"
                  aria-label={t("dashboards.variables.quick")}
                  className="variables__group"
                >
                  {truncated ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      className="menu__item"
                      onClick={() => onChange(options.map((o) => o.value))}
                    >
                      <span className="toolbar-menu__check" aria-hidden="true" />
                      {t("dashboards.variables.selectAll")}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="menu__item"
                    onClick={() => onChange([])}
                  >
                    <span className="toolbar-menu__check" aria-hidden="true" />
                    {t("dashboards.variables.clear")}
                  </button>
                </div>
                <hr className="toolbar-menu__separator" />
                {/* biome-ignore lint/a11y/useSemanticElements: a group of menu items, not a field set */}
                <div role="group" aria-label={label} className="variables__group">
                  {shown.length === 0 ? (
                    <div className="menu__label" role="presentation">
                      {t("dashboards.variables.noMatch")}
                    </div>
                  ) : (
                    shown.map((option) => {
                      const checked = picked.includes(option.value);
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          className="menu__item"
                          onClick={() => toggle(option.value)}
                        >
                          <span className="toolbar-menu__check" aria-hidden="true">
                            {checked ? <Icon name="check" /> : null}
                          </span>
                          <span className="toolbar-menu__label">{option.label}</span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
