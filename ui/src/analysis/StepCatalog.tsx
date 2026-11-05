import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { useFloatingMenu } from "../shell/useFloatingMenu";
import { useMenuButton } from "../shell/useMenuButton";
import type { StepType } from "./steps";
import "../shell/shellUx.css";
import "../components/iconButton.css";
import "./analysis.css";

export type ShapeName = "graph" | "frame" | "documents";

/** The shape a step reads, and the one it makes when that is another: "Graph → Table". */
export function ShapeChip({ from, to }: { from: ShapeName; to?: ShapeName | undefined }) {
  const { t } = useI18n();
  const name = (s: ShapeName) => t(`analysis.shape.${s}`);
  return (
    <span className="shape-chip">
      {to === undefined || to === from
        ? name(from)
        : t("analysis.shape.change", { from: name(from), to: name(to) })}
    </span>
  );
}

/** One kind of step in the catalog. */
export interface CatalogEntry {
  type: StepType;
  label: string;
  about: string;
  from: ShapeName;
  to: ShapeName;
}

/**
 * "+ Add step" and its catalog (Graph board, frame 5B): a popover with a search on top, the
 * graph steps and then the table steps, each with what it does and the shapes it reads and makes.
 * Before a step makes a table, the table steps are one entry that says so. Typing filters by
 * name and description; Down leads from the search to the entries, Up from the first one back.
 */
export function StepCatalog({
  graph,
  table,
  tablesLater,
  onAdd,
}: {
  graph: readonly CatalogEntry[];
  table: readonly CatalogEntry[];
  /** The table steps wait for a step that makes a table. */
  tablesLater: boolean;
  onAdd: (type: StepType) => void;
}) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const floatingKeyDown = useFloatingMenu(menu);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();
  const label = t("analysis.steps.add");

  // Opening puts the focus in the search.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const needle = query.trim().toLocaleLowerCase();
  const matches = (entry: CatalogEntry) =>
    needle === "" ||
    entry.label.toLocaleLowerCase().includes(needle) ||
    entry.about.toLocaleLowerCase().includes(needle);
  const graphShown = graph.filter(matches);
  const tableShown = table.filter(matches);
  const laterShown =
    tablesLater &&
    (needle === "" ||
      t("analysis.catalog.tablesLaterTitle").toLocaleLowerCase().includes(needle) ||
      t("analysis.catalog.tablesLaterAbout").toLocaleLowerCase().includes(needle));
  const nothing = graphShown.length === 0 && tableShown.length === 0 && !laterShown;

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Home, End and Up stay the field's: the caret moves.
    if (event.key === "Home" || event.key === "End" || event.key === "ArrowUp") {
      event.stopPropagation();
    }
    // Enter takes the one entry left.
    if (event.key === "Enter") {
      const only = [...graphShown, ...tableShown];
      if (only.length === 1 && only[0] !== undefined) {
        event.preventDefault();
        closeMenu(true);
        onAdd(only[0].type);
      }
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Up from the first entry goes back to the search.
    if (event.key === "ArrowUp") {
      const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
      if (first !== null && document.activeElement === first) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
    }
    floatingKeyDown(event);
  }

  const item = (entry: CatalogEntry) => {
    const id = `${idPrefix}-${entry.type}`;
    return (
      <button
        key={entry.type}
        type="button"
        role="menuitem"
        className="menu__item step-catalog__item"
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-about`}
        onClick={() => {
          closeMenu(true);
          onAdd(entry.type);
        }}
      >
        <span className="step-catalog__text">
          <span className="step-catalog__name" id={`${id}-name`}>
            {entry.label}
          </span>
          <span className="step-catalog__about" id={`${id}-about`}>
            {entry.about}
          </span>
        </span>
        <ShapeChip from={entry.from} to={entry.to} />
      </button>
    );
  };

  return (
    <div className="menu-anchor toolbar-menu step-catalog" ref={anchorRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--ghost icon-button steps__add-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setQuery("");
          menu.toggle();
        }}
        onKeyDown={menu.onButtonKeyDown}
      >
        <Icon name="plus" />
        <span className="icon-button__text">{label}</span>
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/useSemanticElements: a popup of a search and a menu, not a field set
            <div
              ref={menuRef}
              role="group"
              aria-label={label}
              className="menu step-catalog__popover"
              onKeyDown={onMenuKeyDown}
              // A click in the popover is the popover's, not a click outside that closes it.
              onPointerDown={(event) => event.stopPropagation()}
            >
              <label className="step-catalog__search">
                <Icon name="search" />
                <input
                  ref={searchRef}
                  type="search"
                  className="step-catalog__input"
                  value={query}
                  placeholder={t("analysis.catalog.search")}
                  aria-label={t("analysis.catalog.search")}
                  aria-controls={menuId}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={onSearchKeyDown}
                />
              </label>
              <div id={menuId} role="menu" aria-label={label} className="step-catalog__list">
                {graphShown.length === 0 ? null : (
                  <>
                    <div className="menu__label step-catalog__heading" role="presentation">
                      {t("analysis.catalog.graph")}
                    </div>
                    {graphShown.map(item)}
                  </>
                )}
                {tableShown.length === 0 && !laterShown ? null : (
                  <div className="menu__label step-catalog__heading" role="presentation">
                    {t("analysis.catalog.table")}
                  </div>
                )}
                {tableShown.map(item)}
                {laterShown ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="menu__item step-catalog__item"
                    aria-disabled="true"
                    aria-labelledby={`${idPrefix}-later-name`}
                    aria-describedby={`${idPrefix}-later-about`}
                  >
                    <span className="step-catalog__text">
                      <span className="step-catalog__name" id={`${idPrefix}-later-name`}>
                        {t("analysis.catalog.tablesLaterTitle")}
                      </span>
                      <span className="step-catalog__about" id={`${idPrefix}-later-about`}>
                        {t("analysis.catalog.tablesLaterAbout")}
                      </span>
                    </span>
                    <ShapeChip from="frame" />
                  </button>
                ) : null}
                {nothing ? (
                  <div className="menu__label" role="presentation">
                    {t("analysis.catalog.noMatch")}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
