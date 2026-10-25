import { type KeyboardEvent, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useMenuButton } from "../../shell/useMenuButton";
import type { VariableOption } from "./api";
import "../../shell/shellUx.css";
import "./dashboardTools.css";

/**
 * Puts a menu drawn in the window under its button, kept inside the window: its left edge moves
 * back when it would run past the right one, and its height ends above the window's bottom.
 */
export function placeMenu(button: HTMLElement, list: HTMLElement): void {
  const box = button.getBoundingClientRect();
  const margin = 16;
  list.style.setProperty("--menu-top", `${box.bottom}px`);
  list.style.setProperty("--menu-min", `${box.width}px`);
  list.style.setProperty(
    "--menu-max-height",
    `${Math.max(window.innerHeight - box.bottom - margin, 120)}px`,
  );
  const left = Math.min(box.left, window.innerWidth - list.offsetWidth - margin / 2);
  list.style.setProperty("--menu-left", `${Math.max(left, margin / 2)}px`);
}

/** More options than this get a search field in the menu. */
const SEARCH_FROM = 8;

/** What the picker shows for the chosen values: "All", "North", or "North, East +2". */
export function multiSummary(
  picked: readonly string[],
  list: readonly VariableOption[],
  t: (key: "dashboards.variables.all" | "dashboards.variables.none") => string,
  more: (count: number) => string,
): string {
  if (picked.length === 0) {
    return t("dashboards.variables.none");
  }
  const labels = picked.map((value) => list.find((o) => o.value === value)?.label ?? value);
  if (list.length > 1 && list.every((o) => picked.includes(o.value))) {
    return t("dashboards.variables.all");
  }
  const shown = labels.slice(0, 2).join(", ");
  return labels.length > 2 ? `${shown} ${more(labels.length - 2)}` : shown;
}

/**
 * The picker of a multi-value variable: a button in the look of the single-value select (value
 * summary, chevron) that opens a menu of checkboxes, with "Select all", "None" and, for a long
 * list, a search. The menu stays open while values are toggled; Escape closes it and returns
 * focus to the button.
 */
export function VariableMultiSelect({
  id,
  label,
  picked,
  options,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  picked: readonly string[];
  options: readonly VariableOption[];
  describedBy?: string | undefined;
  onChange: (values: string[]) => void;
}) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const [query, setQuery] = useState("");

  // Values the options no longer list (a stored value, a value set by a click) stay choosable.
  const unknown = picked.filter((v) => !options.some((o) => o.value === v));
  const all: VariableOption[] = [...unknown.map((value) => ({ value, label: value })), ...options];
  const needle = query.trim().toLowerCase();
  const shown =
    needle === ""
      ? all
      : all.filter(
          (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
        );
  const summary = multiSummary(picked, options, t, (count) =>
    t("dashboards.variables.more", { count }),
  );

  function toggle(value: string) {
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    // Keep the options' order, not the order of clicking.
    const order = all.map((o) => o.value);
    onChange(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  }

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (!open || button === null || list === null) {
      return;
    }
    placeMenu(button, list);
  }, [open, buttonRef, menuRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => closeMenu(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open, closeMenu]);

  // The search is typed in, so the menu's Home, End and Up must stay the field's.
  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowUp") {
      event.stopPropagation();
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
      return;
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
        aria-label={`${label}: ${summary}`}
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
            // biome-ignore lint/a11y/noStaticElementInteractions: the keys belong to the menu inside; this only wraps it and its search
            <div
              ref={menuRef}
              className="menu variables__menu"
              onKeyDown={onMenuKeyDown}
              // A click in the menu is the menu's, not a click outside that closes it.
              onPointerDown={(event) => event.stopPropagation()}
            >
              {all.length > SEARCH_FROM ? (
                <input
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
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => onChange(options.map((o) => o.value))}
                >
                  <span className="toolbar-menu__check" aria-hidden="true" />
                  {t("dashboards.variables.selectAll")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => onChange([])}
                >
                  <span className="toolbar-menu__check" aria-hidden="true" />
                  {t("dashboards.variables.clear")}
                </button>
                <hr className="toolbar-menu__separator" />
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
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
