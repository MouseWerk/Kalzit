/**
 * Explicit table roles for a stacking list table. On phones its rows become
 * blocks and grids, and some browsers then drop the implicit table semantics, so a screen reader
 * no longer hears rows, columns and headers. Spelled out as roles they stay, whatever the display.
 * (Written as spreads: on a plain table the linter calls these roles redundant, which they are
 * not once the display changes.)
 */
export const STACK_ROLES = {
  table: { role: "table" },
  rowgroup: { role: "rowgroup" },
  row: { role: "row" },
  columnheader: { role: "columnheader" },
  cell: { role: "cell" },
} as const;
