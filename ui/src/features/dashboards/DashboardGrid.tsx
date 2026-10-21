import { useRef } from "react";
import { GRID_COLUMNS, type GridPos, type PanelModel, readingOrder } from "./model";
import { PanelCard } from "./PanelCard";
import type { PanelQueryInput } from "./usePanelResults";

/** Fallback cell height in px when the grid cannot be measured (no layout in tests). */
const FALLBACK_ROW_HEIGHT = 32;

interface DashboardGridProps {
  panels: readonly PanelModel[];
  query: Omit<PanelQueryInput, "panel">;
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
export function DashboardGrid({ panels, query, edit }: DashboardGridProps) {
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

  return (
    <div className="dash-grid" ref={ref}>
      {readingOrder(panels).map((panel) => (
        <PanelCard
          key={panel.id}
          panel={panel}
          query={query}
          edit={
            edit === undefined
              ? undefined
              : {
                  onEdit: () => edit.onEdit(panel.id),
                  onDuplicate: () => edit.onDuplicate(panel.id),
                  onRemove: () => edit.onRemove(panel.id),
                  onGrid: (grid) => edit.onGrid(panel.id, grid),
                  cellSize,
                }
          }
        />
      ))}
    </div>
  );
}
