/**
 * Where a hover tooltip goes. Tooltips lie above the whole page (FloatingTooltip renders them at
 * the end of the body, on the tooltip layer) and are placed in viewport coordinates from the
 * point they belong to: beside it, on the other side when the viewport's edge is in the way
 * (flip), and pushed back inside when neither side has the room (shift).
 */

/** The point a tooltip belongs to, in viewport coordinates, and its distance from it. */
export interface TooltipAnchor {
  x: number;
  y: number;
  /** The gap between the point and the tooltip, per axis. */
  gapX: number;
  gapY: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A tooltip keeps this distance from the viewport's edges. */
export const VIEWPORT_MARGIN_PX = 4;
/** A tooltip beside the pointer: far enough that the cursor does not cover it. */
export const POINTER_GAP_PX = 12;
/** A tooltip beside a line or control it describes. */
export const ANCHOR_GAP_PX = 8;

/**
 * One axis: after the point, before it when the end is in the way and there is room before,
 * otherwise as close to its side as the viewport allows.
 */
function along(at: number, gap: number, size: number, viewport: number): number {
  const first = VIEWPORT_MARGIN_PX;
  const last = viewport - VIEWPORT_MARGIN_PX - size;
  const after = at + gap;
  if (after <= last) {
    return Math.max(after, first);
  }
  const before = at - gap - size;
  if (before >= first) {
    // A point past the edge itself still gives a place inside.
    return Math.min(before, last);
  }
  // No room on either side: inside the viewport, the start kept when it is too small for all.
  return Math.max(Math.min(after, last), first);
}

/** The top left corner of a tooltip of `size` for `anchor`, inside the `viewport`. */
export function placeTooltip(
  anchor: TooltipAnchor,
  size: Size,
  viewport: Size,
): { left: number; top: number } {
  return {
    left: along(anchor.x, anchor.gapX, size.width, viewport.width),
    top: along(anchor.y, anchor.gapY, size.height, viewport.height),
  };
}

/** The viewport without its scroll bars. */
export function viewportSize(): Size {
  const root = document.documentElement;
  return {
    width: root.clientWidth || window.innerWidth,
    height: root.clientHeight || window.innerHeight,
  };
}

/**
 * The part of `element` that is on screen: its box cut by the viewport and by every ancestor
 * that clips or scrolls. `null` when nothing of it shows, so a tooltip for a chart that is
 * scrolled away does not hang over the page.
 */
export function visibleBox(element: Element): Box | null {
  const viewport = viewportSize();
  const rect = element.getBoundingClientRect();
  const box: Box = {
    left: Math.max(rect.left, 0),
    top: Math.max(rect.top, 0),
    right: Math.min(rect.right, viewport.width),
    bottom: Math.min(rect.bottom, viewport.height),
  };
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    const clips = (overflow: string) => overflow !== "" && overflow !== "visible";
    if (!clips(overflowX) && !clips(overflowY)) {
      continue;
    }
    const clip = parent.getBoundingClientRect();
    box.left = Math.max(box.left, clip.left);
    box.top = Math.max(box.top, clip.top);
    box.right = Math.min(box.right, clip.right);
    box.bottom = Math.min(box.bottom, clip.bottom);
  }
  return box.right > box.left && box.bottom > box.top ? box : null;
}
