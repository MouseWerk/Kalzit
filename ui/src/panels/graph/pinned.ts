/**
 * Pinned nodes, as the layouts see them (Graph081 board, frame 14): a node that was dragged or
 * pinned keeps its position, saved per panel, and every layout arranges the other nodes around
 * it. Who pins, where the positions are kept (the panel's options while editing, the viewer's
 * view state while viewing) and undo belong to the canvas interaction, which hands them over
 * with `pinnedForLayouts` (canvas/indexes.ts); the layouts only read this.
 */

/** Node id (as in the result, not the view key) to its position in the layout's coordinates. */
export type PinnedPositions = ReadonlyMap<string, readonly [x: number, y: number]>;

export interface PinnedNodes {
  positions: PinnedPositions;
  /**
   * Releases every pinned node: a change of layout does, and so does the layout menu's
   * "Release pinned nodes". Absent where nothing can be released.
   */
  release?: () => void;
}

/** No pinned nodes: what a layout reads when it is given none. */
export const NO_PINNED_NODES: PinnedNodes = { positions: new Map() };
