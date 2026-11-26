/**
 * Pinned nodes, as the layouts see them (Graph081 board, frame 14): a node that was dragged or
 * pinned keeps its position, saved per panel, and every layout arranges the other nodes around
 * it. Who pins, where the positions are kept (the panel's options while editing, the viewer's
 * view state while viewing) and undo belong to the canvas interaction; the layouts only read
 * this.
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

/** No pinned nodes: what a panel has until its canvas keeps some. */
export const NO_PINNED_NODES: PinnedNodes = { positions: new Map() };

/**
 * The pinned nodes of the panel being shown. Until the canvas interaction keeps pinned positions
 * this is always "none"; it then reads them from the panel's options or the viewer's view state.
 */
export function usePinnedNodes(): PinnedNodes {
  return NO_PINNED_NODES;
}
