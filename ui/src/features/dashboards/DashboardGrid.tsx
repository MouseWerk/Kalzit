import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import type { LinkedPanel } from "./api";
import { layoutSections, type PlacedPanel, panelValues, type Section } from "./layout";
import {
  clampGrid,
  GRID_COLUMNS,
  type GridPos,
  type PanelModel,
  type RowModel,
  type VariableValues,
} from "./model";
import { PanelCard, type PanelViewActions } from "./PanelCard";
import { panelRange } from "./panelTime";
import type { PanelQueryInput } from "./usePanelResults";
import "./dashboardTools.css";

/** Fallback cell height in px when the grid cannot be measured (no layout in tests). */
const FALLBACK_ROW_HEIGHT = 32;

export interface GridEditActions {
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onGrid: (id: string, grid: GridPos) => void;
  onCopy: (id: string) => void;
  onRowMove: (from: number, to: number) => void;
  onRowEdit: (rowId: string) => void;
  onRowRemove: (rowId: string) => void;
  onRowToggle: (rowId: string) => void;
}

interface DashboardGridProps {
  panels: readonly PanelModel[];
  rows: readonly RowModel[];
  /** The library panels the dashboard shows, by id. */
  libraryPanels: Record<string, LinkedPanel>;
  query: Omit<PanelQueryInput, "panel" | "variables"> & { variables: VariableValues };
  /** When the range was resolved: a panel's own relative range ends then. */
  now: number;
  /**
   * The saved panels. In edit mode a panel whose queries differ from its saved version (or that
   * is new) runs through the free query route; every other panel keeps the panel route.
   */
  storedPanels?: readonly PanelModel[];
  /** Rows opened or closed while viewing, which is not saved. */
  collapsed: (row: RowModel) => boolean;
  onToggleRow: (row: RowModel) => void;
  view?: Omit<PanelViewActions, "values"> | undefined;
  edit?: GridEditActions | undefined;
}

/** A panel showing a library panel draws the library panel's content in its own place. */
export function resolvePanel(panel: PanelModel, library: Record<string, LinkedPanel>): PanelModel {
  const linked = panel.libraryPanelId === undefined ? undefined : library[panel.libraryPanelId];
  if (linked === undefined) {
    return panel;
  }
  const { id, grid, rowId, repeat } = panel;
  const place: Partial<PanelModel> = { id, grid, libraryPanelId: linked.id };
  if (rowId !== undefined) place.rowId = rowId;
  if (repeat !== undefined) place.repeat = repeat;
  return { ...linked.model, ...place };
}

/**
 * The dashboard's sections: the panels outside every row, then each row with its panels, in the
 * 24-column grid. Panels are in reading order in the document, so Tab and screen readers go top
 * to bottom and left to right whatever order they were added in. Repeats are expanded while
 * viewing; in edit mode each panel and row shows once, as stored.
 */
export function DashboardGrid({
  panels,
  rows,
  libraryPanels,
  query,
  now,
  storedPanels = [],
  collapsed,
  onToggleRow,
  view,
  edit,
}: DashboardGridProps) {
  const { t } = useI18n();
  const [announcement, setAnnouncement] = useState("");
  const resolved = panels.map((p) => resolvePanel(p, libraryPanels));
  const stored = new Map(
    storedPanels.map((p) => [p.id, JSON.stringify(resolvePanel(p, libraryPanels).targets)]),
  );
  const sections = layoutSections(resolved, rows, query.variables, edit === undefined);
  const [focusRow, setFocusRow] = useState<string | null>(null);

  function moveRow(index: number, to: number, byKeyboard: boolean) {
    if (edit === undefined || to < 0 || to >= rows.length || to === index) {
      return;
    }
    const row = rows[index];
    edit.onRowMove(index, to);
    if (row !== undefined && byKeyboard) {
      setFocusRow(row.id);
      setAnnouncement(
        t("dashboardTools.rows.moved", {
          title: row.title === "" ? t("dashboardTools.rows.untitled") : row.title,
          position: to + 1,
          count: rows.length,
        }),
      );
    }
  }

  return (
    <div className="dash-sections">
      {sections.map((section) => {
        const isCollapsed = section.row !== null && collapsed(section.row);
        const rowIndex = section.row === null ? -1 : rows.indexOf(section.row);
        return (
          <section
            key={section.key}
            className="dash-section"
            aria-label={
              section.row === null ? undefined : rowLabel(t, section.row, section.repeat?.value)
            }
          >
            {section.row === null ? null : (
              <RowHeader
                row={section.row}
                section={section}
                index={rowIndex}
                count={rows.length}
                collapsed={isCollapsed}
                focus={focusRow === section.row.id && section.first}
                onFocused={() => setFocusRow(null)}
                onToggle={() =>
                  section.row !== null &&
                  (edit === undefined ? onToggleRow(section.row) : edit.onRowToggle(section.row.id))
                }
                edit={edit !== undefined && section.first ? edit : undefined}
                onMove={(to, byKeyboard) => moveRow(rowIndex, to, byKeyboard)}
              />
            )}
            {isCollapsed ? null : (
              <SectionGrid
                section={section}
                query={query}
                now={now}
                stored={stored}
                view={view}
                edit={edit !== undefined && section.first ? edit : undefined}
                onAnnounce={setAnnouncement}
              />
            )}
          </section>
        );
      })}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}

function rowLabel(t: ReturnType<typeof useI18n>["t"], row: RowModel, value?: string) {
  const title = row.title === "" ? t("dashboardTools.rows.untitled") : row.title;
  return value === undefined ? title : `${title}: ${value}`;
}

function SectionGrid({
  section,
  query,
  now,
  stored,
  view,
  edit,
  onAnnounce,
}: {
  section: Section;
  query: DashboardGridProps["query"];
  now: number;
  stored: Map<string, string>;
  view: DashboardGridProps["view"];
  edit: GridEditActions | undefined;
  onAnnounce: (text: string) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  function cellSize() {
    const grid = ref.current;
    if (grid === null) {
      return { width: 40, height: FALLBACK_ROW_HEIGHT };
    }
    const style = getComputedStyle(grid);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const rowHeight = Number.parseFloat(style.gridAutoRows) || FALLBACK_ROW_HEIGHT;
    return {
      width: (grid.clientWidth + gap) / GRID_COLUMNS,
      height: rowHeight + (Number.parseFloat(style.rowGap) || 0),
    };
  }
  if (section.panels.length === 0) {
    return edit === undefined || section.row === null ? null : (
      <p className="dash-section__empty">{t("dashboardTools.rows.empty")}</p>
    );
  }
  return (
    <div className="dash-grid" ref={ref}>
      {section.panels.map((placed: PlacedPanel) => {
        const panel = { ...placed.panel, grid: placed.grid };
        const changed =
          edit !== undefined && stored.get(panel.id) !== JSON.stringify(panel.targets);
        const values = panelValues(query.variables, placed, section);
        return (
          <PanelCard
            key={placed.key}
            panel={panel}
            repeatValue={placed.repeat?.value}
            query={{
              ...query,
              variables: values,
              range: panelRange(panel, query.range, now),
              source: changed ? "draft" : "stored",
            }}
            view={view === undefined ? undefined : { ...view, values }}
            edit={
              edit === undefined
                ? undefined
                : {
                    onEdit: () => edit.onEdit(panel.id),
                    onDuplicate: () => edit.onDuplicate(panel.id),
                    onRemove: () => edit.onRemove(panel.id),
                    onCopy: () => edit.onCopy(panel.id),
                    onGrid: (grid, byKeyboard) => {
                      edit.onGrid(panel.id, grid);
                      if (byKeyboard) {
                        const g = clampGrid(grid);
                        onAnnounce(
                          t("dashboards.panel.placed", {
                            title:
                              panel.title === "" ? t("dashboards.panel.untitled") : panel.title,
                            column: g.x + 1,
                            row: g.y + 1,
                            width: g.w,
                            height: g.h,
                          }),
                        );
                      }
                    },
                    cellSize,
                  }
            }
          />
        );
      })}
    </div>
  );
}

function RowHeader({
  row,
  section,
  index,
  count,
  collapsed,
  focus,
  onFocused,
  onToggle,
  edit,
  onMove,
}: {
  row: RowModel;
  section: Section;
  index: number;
  count: number;
  collapsed: boolean;
  focus: boolean;
  onFocused: () => void;
  onToggle: () => void;
  edit: GridEditActions | undefined;
  onMove: (to: number, byKeyboard: boolean) => void;
}) {
  const { t } = useI18n();
  const handleRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const title = rowLabel(t, row, section.repeat?.value);
  // A keyboard move puts the row elsewhere in the document; its handle takes focus back.
  useEffect(() => {
    if (focus) {
      handleRef.current?.focus();
      onFocused();
    }
  }, [focus, onFocused]);

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (step !== 0) {
      event.preventDefault();
      onMove(index + step, true);
    }
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }
    const target = event.currentTarget;
    const list = target.closest(".dash-sections");
    target.setPointerCapture(event.pointerId);
    const onUp = (up: globalThis.PointerEvent) => {
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      // The row lands before the first row header below the pointer.
      const headers = Array.from(list?.querySelectorAll<HTMLElement>("[data-row-index]") ?? []);
      const below = headers.find((h) => up.clientY < h.getBoundingClientRect().top);
      const to =
        below === undefined
          ? count - 1
          : Number(below.dataset.rowIndex) - (Number(below.dataset.rowIndex) > index ? 1 : 0);
      onMove(to, false);
    };
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  return (
    <div className="dash-row" data-row-index={section.first ? index : undefined}>
      <button
        type="button"
        className="dash-row__toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <span className="dash-row__chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="dash-row__title truncate">{title}</span>
        {collapsed && section.panels.length > 0 ? (
          <span className="dash-row__count">
            {t("dashboardTools.rows.panelCount", { count: section.panels.length })}
          </span>
        ) : null}
      </button>
      {edit === undefined ? null : (
        <div className="dash-row__actions">
          <button
            type="button"
            ref={handleRef}
            className="button button--ghost button--small dash-row__handle"
            aria-label={t("dashboardTools.rows.move", { title })}
            title={t("dashboardTools.rows.moveHint")}
            aria-describedby={hintId}
            onKeyDown={onKey}
            onPointerDown={startDrag}
          >
            <span aria-hidden="true">⠿</span>
          </button>
          <span className="visually-hidden" id={hintId}>
            {t("dashboardTools.rows.moveHint")}
          </span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => edit.onRowEdit(row.id)}
            aria-label={t("dashboardTools.rows.editNamed", { title })}
          >
            {t("dashboardTools.rows.edit")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => edit.onRowRemove(row.id)}
            aria-label={t("dashboardTools.rows.removeNamed", { title })}
          >
            {t("dashboardTools.rows.remove")}
          </button>
        </div>
      )}
    </div>
  );
}
