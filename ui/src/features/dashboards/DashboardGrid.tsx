import { useRef, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { clampGrid, GRID_COLUMNS, type GridPos, type PanelModel, readingOrder } from "./model";
import { PanelCard } from "./PanelCard";
import type { PanelQueryInput } from "./usePanelResults";

/** Fallback cell height in px when the grid cannot be measured (no layout in tests). */
const FALLBACK_ROW_HEIGHT = 32;

interface DashboardGridProps {
  panels: readonly PanelModel[];
  query: Omit<PanelQueryInput, "panel">;
  /**
   * The saved panels. In edit mode a panel whose queries differ from its saved version (or that
   * is new) runs through the free query route; every other panel keeps the panel route.
   */
  storedPanels?: readonly PanelModel[];
  edit?:
    | {
        onEdit: (id: string) => void;
        onDuplicate: (id: string) => void;
        onRemove: (id: string) => void;
        onGrid: (id: string, grid: GridPos) => void;
      }
    | undefined;
}

/**
 * The 24-column grid. Panels are in reading order in the document, so Tab and screen readers go
 * top to bottom and left to right whatever order they were added in.
 */
export function DashboardGrid({ panels, query, storedPanels = [], edit }: DashboardGridProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const stored = new Map(storedPanels.map((p) => [p.id, JSON.stringify(p.targets)]));

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

  return (
    <>
      <div className="dash-grid" ref={ref}>
        {readingOrder(panels).map((panel) => {
          const changed =
            edit !== undefined && stored.get(panel.id) !== JSON.stringify(panel.targets);
          return (
            <PanelCard
              key={panel.id}
              panel={panel}
              query={{ ...query, source: changed ? "draft" : "stored" }}
              edit={
                edit === undefined
                  ? undefined
                  : {
                      onEdit: () => edit.onEdit(panel.id),
                      onDuplicate: () => edit.onDuplicate(panel.id),
                      onRemove: () => edit.onRemove(panel.id),
                      onGrid: (grid, byKeyboard) => {
                        edit.onGrid(panel.id, grid);
                        if (byKeyboard) {
                          const g = clampGrid(grid);
                          setAnnouncement(
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
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </>
  );
}
