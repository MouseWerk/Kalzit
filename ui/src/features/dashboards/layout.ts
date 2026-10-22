import {
  GRID_COLUMNS,
  type GridPos,
  MIN_PANEL_WIDTH,
  type PanelModel,
  placePanel,
  type RowModel,
  readingOrder,
  type VariableValues,
  valueList,
} from "./model";

/**
 * Rows and repeats (docs/api/dashboard-features.md). The dashboard is a list of sections: the
 * panels outside every row first, then each row with its panels. A panel's grid counts from the
 * top of its section. Repeats are expanded here, for viewing: one section per value of a repeated
 * row's variable, one copy per value of a repeated panel's variable.
 */

/** One panel as drawn: the stored panel, where it goes, and the variable value of its copy. */
export interface PlacedPanel {
  /** Unique among the drawn panels; the panel's id, or the id and its repeat value. */
  key: string;
  panel: PanelModel;
  grid: GridPos;
  /** Set for a copy made by a repeat: the variable and the one value it shows. */
  repeat?: { variable: string; value: string } | undefined;
}

export interface Section {
  key: string;
  /** `null` for the panels outside every row. */
  row: RowModel | null;
  /** Set for a copy of a repeated row. */
  repeat?: { variable: string; value: string } | undefined;
  /** Only the first copy of a repeated row can be arranged and edited. */
  first: boolean;
  panels: PlacedPanel[];
}

/** The panels of one section: outside every row (`null`) or in that row. */
export function panelsOf(
  panels: readonly PanelModel[],
  rowId: string | null,
  rows: readonly RowModel[],
) {
  const known = new Set(rows.map((r) => r.id));
  return panels.filter((p) =>
    rowId === null ? p.rowId === undefined || !known.has(p.rowId) : p.rowId === rowId,
  );
}

/** Copies of a repeated panel, laid out side by side (wrapping) or below each other. */
function expandPanel(panel: PanelModel, values: VariableValues): PlacedPanel[] {
  const repeat = panel.repeat;
  const list = repeat === undefined ? [] : valueList(values[repeat.variable]);
  if (repeat === undefined || list.length === 0) {
    return [{ key: panel.id, panel, grid: panel.grid }];
  }
  const perRow = Math.max(1, Math.min(list.length, repeat.maxPerRow ?? list.length));
  const width = Math.max(MIN_PANEL_WIDTH, Math.floor(GRID_COLUMNS / perRow));
  return list.map((value, index) => {
    const grid =
      repeat.direction === "vertical"
        ? { ...panel.grid, y: panel.grid.y + index * panel.grid.h }
        : {
            x: Math.min((index % perRow) * width, GRID_COLUMNS - width),
            y: panel.grid.y + Math.floor(index / perRow) * panel.grid.h,
            w: width,
            h: panel.grid.h,
          };
    return {
      key: index === 0 ? panel.id : `${panel.id}\u0000${value}`,
      panel,
      grid,
      repeat: { variable: repeat.variable, value },
    };
  });
}

/** Lays out one section's panels, expanding repeats and pushing what they cover down. */
function placeSection(
  panels: readonly PanelModel[],
  values: VariableValues,
  expand: boolean,
): PlacedPanel[] {
  if (!expand) {
    return readingOrder(panels).map((panel) => ({ key: panel.id, panel, grid: panel.grid }));
  }
  const placed = panels.flatMap((panel) => expandPanel(panel, values));
  // Positions of the copies, with collisions resolved as when a panel is moved.
  let grid = placed.map((p) => ({ ...p.panel, id: p.key, grid: p.grid }));
  for (const p of placed) {
    if (p.repeat !== undefined) {
      grid = placePanel(grid, p.key, grid.find((g) => g.id === p.key)?.grid ?? p.grid);
    }
  }
  const at = new Map(grid.map((g) => [g.id, g.grid]));
  return placed
    .map((p) => ({ ...p, grid: at.get(p.key) ?? p.grid }))
    .sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
}

/**
 * The sections to draw. `expand` turns repeats into copies (viewing); in edit mode each panel
 * and row is drawn once, so what is arranged is what is stored.
 */
export function layoutSections(
  panels: readonly PanelModel[],
  rows: readonly RowModel[],
  values: VariableValues,
  expand: boolean,
): Section[] {
  const sections: Section[] = [
    {
      key: "top",
      row: null,
      first: true,
      panels: placeSection(panelsOf(panels, null, rows), values, expand),
    },
  ];
  for (const row of rows) {
    const own = panelsOf(panels, row.id, rows);
    const repeatValues =
      row.repeat === undefined || !expand ? [] : valueList(values[row.repeat.variable]);
    if (row.repeat === undefined || repeatValues.length === 0) {
      sections.push({ key: row.id, row, first: true, panels: placeSection(own, values, expand) });
      continue;
    }
    const variable = row.repeat.variable;
    repeatValues.forEach((value, index) => {
      sections.push({
        key: index === 0 ? row.id : `${row.id}\u0000${value}`,
        row,
        repeat: { variable, value },
        first: index === 0,
        // Inside the copy the row's variable has this one value.
        panels: placeSection(own, { ...values, [variable]: value }, expand).map((p) => ({
          ...p,
          key: index === 0 ? p.key : `${p.key}\u0000${value}`,
          repeat: p.repeat ?? { variable, value },
        })),
      });
    });
  }
  return sections;
}

/** The variable values one drawn panel's queries run with: its copy's value replaces the list. */
export function panelValues(
  values: VariableValues,
  placed: { repeat?: PlacedPanel["repeat"] },
  section?: Section,
) {
  const out = { ...values };
  if (section?.repeat !== undefined) {
    out[section.repeat.variable] = section.repeat.value;
  }
  if (placed.repeat !== undefined) {
    out[placed.repeat.variable] = placed.repeat.value;
  }
  return out;
}

/** Moves or resizes a panel inside its own section; panels of other sections stay. */
export function placeInSection(
  panels: readonly PanelModel[],
  id: string,
  grid: GridPos,
  rows: readonly RowModel[],
) {
  const moving = panels.find((p) => p.id === id);
  if (moving === undefined) {
    return [...panels];
  }
  const rowId =
    moving.rowId !== undefined && rows.some((r) => r.id === moving.rowId) ? moving.rowId : null;
  const own = panelsOf(panels, rowId, rows);
  const placed = new Map(placePanel(own, id, grid).map((p) => [p.id, p]));
  return panels.map((p) => placed.get(p.id) ?? p);
}

/** The first free line of a section, where a panel added to it goes. */
export function sectionBottom(
  panels: readonly PanelModel[],
  rowId: string | null,
  rows: readonly RowModel[],
) {
  return panelsOf(panels, rowId, rows).reduce((max, p) => Math.max(max, p.grid.y + p.grid.h), 0);
}

/** Moves the row at `from` to `to` (both indexes in `rows`). */
export function moveRow(rows: readonly RowModel[], from: number, to: number): RowModel[] {
  const next = [...rows];
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [row] = next.splice(from, 1);
  if (row === undefined) {
    return [...rows];
  }
  next.splice(target, 0, row);
  return next;
}
