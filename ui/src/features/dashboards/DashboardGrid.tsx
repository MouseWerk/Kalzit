import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n/i18n";
import type { LinkedAnalysis, LinkedPanel } from "./api";
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
  /** The panel the inspector shows, and selecting one by clicking it. */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
}

interface DashboardGridProps {
  panels: readonly PanelModel[];
  rows: readonly RowModel[];
  /** The library panels the dashboard shows, by id. */
  libraryPanels: Record<string, LinkedPanel>;
  /** The saved analyses its panels link, by id. */
  analyses?: Record<string, LinkedAnalysis> | undefined;
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

/** Resolved library panels per slot and library version, so an unchanged slot keeps its object. */
const resolved = new WeakMap<PanelModel, { linked: LinkedPanel; panel: PanelModel }>();

/** Resolved analysis links per slot and analysis version, for the same reason. */
const resolvedAnalyses = new WeakMap<PanelModel, { linked: LinkedAnalysis; panel: PanelModel }>();

const NO_ANALYSES: Record<string, LinkedAnalysis> = {};

/**
 * A panel showing a library panel draws the library panel's content in its own place; one
 * linking a saved analysis runs the analysis's queries and steps with its own look and title.
 */
export function resolvePanel(
  panel: PanelModel,
  library: Record<string, LinkedPanel>,
  analyses: Record<string, LinkedAnalysis> = NO_ANALYSES,
): PanelModel {
  const analysis = panel.analysisId === undefined ? undefined : analyses[panel.analysisId];
  if (analysis !== undefined) {
    const known = resolvedAnalyses.get(panel);
    if (known !== undefined && known.linked === analysis) {
      return known.panel;
    }
    const result = {
      ...panel,
      targets: analysis.model.targets,
      transformations: analysis.model.steps,
    };
    resolvedAnalyses.set(panel, { linked: analysis, panel: result });
    return result;
  }
  const linked = panel.libraryPanelId === undefined ? undefined : library[panel.libraryPanelId];
  if (linked === undefined) {
    return panel;
  }
  const known = resolved.get(panel);
  if (known !== undefined && known.linked === linked) {
    return known.panel;
  }
  const { id, grid, rowId, repeat } = panel;
  const place: Partial<PanelModel> = { id, grid, libraryPanelId: linked.id };
  if (rowId !== undefined) place.rowId = rowId;
  if (repeat !== undefined) place.repeat = repeat;
  const result = { ...linked.model, ...place };
  resolved.set(panel, { linked, panel: result });
  return result;
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
  analyses = NO_ANALYSES,
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
  const drawn = panels.map((p) => resolvePanel(p, libraryPanels, analyses));
  // Panels whose queries differ from the saved ones (or are new), worked out once per change of
  // the panels instead of per card and render.
  const changed = changedPanels(drawn, storedPanels, libraryPanels, analyses);
  const sections = layoutSections(drawn, rows, query.variables, edit === undefined);
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
                changed={changed}
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

/** Targets as text per stored targets list, so each saved panel is serialized once. */
const targetTexts = new WeakMap<readonly unknown[], string>();
function targetsText(targets: readonly unknown[]): string {
  let text = targetTexts.get(targets);
  if (text === undefined) {
    text = JSON.stringify(targets);
    targetTexts.set(targets, text);
  }
  return text;
}

/** Ids of the drawn panels whose queries are not the saved ones; new panels are among them. */
function changedPanels(
  drawn: readonly PanelModel[],
  storedPanels: readonly PanelModel[],
  library: Record<string, LinkedPanel>,
  analyses: Record<string, LinkedAnalysis>,
): ReadonlySet<string> {
  const stored = new Map(
    storedPanels.map((p) => [p.id, targetsText(resolvePanel(p, library, analyses).targets)]),
  );
  return new Set(drawn.filter((p) => stored.get(p.id) !== targetsText(p.targets)).map((p) => p.id));
}

function SectionGrid({
  section,
  query,
  now,
  changed,
  view,
  edit,
  onAnnounce,
}: {
  section: Section;
  query: DashboardGridProps["query"];
  now: number;
  changed: ReadonlySet<string>;
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
      {section.panels.map((placed: PlacedPanel) => (
        <GridCard
          key={placed.key}
          panel={placed.panel}
          x={placed.grid.x}
          y={placed.grid.y}
          w={placed.grid.w}
          h={placed.grid.h}
          rowVariable={section.repeat?.variable}
          rowValue={section.repeat?.value}
          repeatVariable={placed.repeat?.variable}
          repeatValue={placed.repeat?.value}
          query={query}
          now={now}
          changed={edit !== undefined && changed.has(placed.panel.id)}
          selected={edit?.selectedId === placed.panel.id}
          view={view}
          edit={edit}
          cellSize={cellSize}
          onAnnounce={onAnnounce}
        />
      ))}
    </div>
  );
}

/**
 * One card of the grid. Its props are the stored panel and plain values, so a card whose panel,
 * place and inputs did not change is skipped when the dashboard draws again (a drop, another
 * panel's edit, a variable that this panel does not use still re-runs through `query`).
 */
const GridCard = memo(function GridCard({
  panel: stored,
  x,
  y,
  w,
  h,
  rowVariable,
  rowValue,
  repeatVariable,
  repeatValue,
  query,
  now,
  changed,
  selected,
  view,
  edit,
  cellSize,
  onAnnounce,
}: {
  panel: PanelModel;
  selected: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  rowVariable: string | undefined;
  rowValue: string | undefined;
  repeatVariable: string | undefined;
  repeatValue: string | undefined;
  query: DashboardGridProps["query"];
  now: number;
  changed: boolean;
  view: DashboardGridProps["view"];
  edit: GridEditActions | undefined;
  cellSize: () => { width: number; height: number };
  onAnnounce: (text: string) => void;
}) {
  const { t } = useI18n();
  const panel = { ...stored, grid: { x, y, w, h } };
  const copy = (variable: string | undefined, value: string | undefined) =>
    variable === undefined || value === undefined ? undefined : { variable, value };
  const values = panelValues(
    query.variables,
    { repeat: copy(repeatVariable, repeatValue) },
    { repeat: copy(rowVariable, rowValue) },
  );
  const id = panel.id;
  const title = panel.title;
  return (
    <PanelCard
      panel={panel}
      repeatValue={repeatValue}
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
              onEdit: () => edit.onEdit(id),
              onDuplicate: () => edit.onDuplicate(id),
              onRemove: () => edit.onRemove(id),
              onCopy: () => edit.onCopy(id),
              onGrid: (grid, byKeyboard) => {
                edit.onGrid(id, grid);
                if (byKeyboard) {
                  const g = clampGrid(grid);
                  onAnnounce(
                    t("dashboards.panel.placed", {
                      title: title === "" ? t("dashboards.panel.untitled") : title,
                      column: g.x + 1,
                      row: g.y + 1,
                      width: g.w,
                      height: g.h,
                    }),
                  );
                }
              },
              cellSize,
              selected,
              ...(edit.onSelect === undefined ? {} : { onSelect: () => edit.onSelect?.(id) }),
            }
      }
    />
  );
});

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
        <span className="dash-row__title truncate" title={title}>
          {title}
        </span>
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
