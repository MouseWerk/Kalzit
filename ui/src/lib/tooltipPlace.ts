/**
 * Where a hover tooltip goes. Tooltips lie above the whole page (FloatingTooltip renders them at
 * the end of the body, on the tooltip layer) and are placed in viewport coordinates. What they
 * belong to decides how:
 *
 * - the pointer: beside it, anywhere in the viewport, on the other side when an edge is in the
 *   way (flip) and pushed back inside when neither side has the room (shift);
 * - a line or corner of a chart (the keyboard's readout, the time another panel points at):
 *   inside what shows of that chart, never over a neighbour or a bar, and not at all when it
 *   does not fit there;
 * - a control (an icon button): under it, lined up with one of its edges, or beside it.
 */

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

/** A point a tooltip belongs to, in viewport coordinates, and its distance from it. */
export interface PointAnchor {
  x: number;
  y: number;
  /** The gap between the point and the tooltip, per axis. */
  gapX: number;
  gapY: number;
  /**
   * The box the tooltip has to stay in: what shows of the chart it belongs to. It is as wide as
   * that box at most, opens downwards only, and is not shown when it does not fit. Without a
   * box (the pointer's tooltip) it floats freely in the viewport.
   */
  within?: Box;
}

/** A control a tooltip names: below it (or above), or before it (or after), as room allows. */
export interface ControlAnchor {
  control: Box;
  side: "below" | "before";
  /** Below a control: which of its edges the tooltip lines up with. */
  align: "start" | "end";
}

export type TooltipAnchor = PointAnchor | ControlAnchor;

/** A tooltip keeps this distance from the viewport's edges. */
export const VIEWPORT_MARGIN_PX = 4;
/** A tooltip beside the pointer: far enough that the cursor does not cover it. */
export const POINTER_GAP_PX = 12;
/** A tooltip beside a line it describes, or beside a control. */
export const ANCHOR_GAP_PX = 8;
/** A tooltip under the control it names. */
export const CONTROL_GAP_PX = 4;

/**
 * Marks a bar that sticks to the top of the page and covers what scrolls under it (the top bar,
 * the dashboard toolbar): a chart half under one shows only below it.
 */
export const STICKY_BAR_ATTRIBUTE = "data-sticky-bar";

function clamp(value: number, first: number, last: number): number {
  // The start wins when there is too little room for all of it.
  return Math.max(Math.min(value, last), first);
}

/**
 * One axis between `first` and `end`: after the point, before it when the end is in the way and
 * there is room before, otherwise as close to its side as the room allows.
 */
function beside(at: number, gap: number, size: number, first: number, end: number): number {
  const last = end - size;
  const after = at + gap;
  if (after <= last) {
    return Math.max(after, first);
  }
  const before = at - gap - size;
  if (before >= first) {
    // A point past the edge itself still gives a place inside.
    return Math.min(before, last);
  }
  return clamp(after, first, last);
}

function placeAtControl(anchor: ControlAnchor, size: Size, viewport: Size) {
  const { control } = anchor;
  // A control that has left the viewport takes its tooltip along; it is not held at the edge.
  if (
    control.bottom <= 0 ||
    control.top >= viewport.height ||
    control.right <= 0 ||
    control.left >= viewport.width
  ) {
    return null;
  }
  const first = VIEWPORT_MARGIN_PX;
  const lastLeft = viewport.width - VIEWPORT_MARGIN_PX - size.width;
  const lastTop = viewport.height - VIEWPORT_MARGIN_PX - size.height;
  if (anchor.side === "before") {
    const before = control.left - ANCHOR_GAP_PX - size.width;
    const left = before >= first ? before : control.right + ANCHOR_GAP_PX;
    const middle = (control.top + control.bottom) / 2 - size.height / 2;
    return { left: clamp(left, first, lastLeft), top: clamp(middle, first, lastTop) };
  }
  const below = control.bottom + CONTROL_GAP_PX;
  const above = control.top - CONTROL_GAP_PX - size.height;
  const top = below > lastTop && above >= first ? above : below;
  const left = anchor.align === "end" ? control.right - size.width : control.left;
  return { left: clamp(left, first, lastLeft), top: clamp(top, first, lastTop) };
}

/**
 * The top left corner of a tooltip of `size` for `anchor`; `null` when the tooltip has to stay
 * inside a box it does not fit into.
 */
export function placeTooltip(
  anchor: TooltipAnchor,
  size: Size,
  viewport: Size,
): { left: number; top: number } | null {
  if ("control" in anchor) {
    return placeAtControl(anchor, size, viewport);
  }
  const { within } = anchor;
  if (within === undefined) {
    return {
      left: beside(
        anchor.x,
        anchor.gapX,
        size.width,
        VIEWPORT_MARGIN_PX,
        viewport.width - VIEWPORT_MARGIN_PX,
      ),
      top: beside(
        anchor.y,
        anchor.gapY,
        size.height,
        VIEWPORT_MARGIN_PX,
        viewport.height - VIEWPORT_MARGIN_PX,
      ),
    };
  }
  if (size.width > within.right - within.left || size.height > within.bottom - within.top) {
    return null;
  }
  return {
    // Either side of the line, inside the chart; never above it, where another panel lies.
    left: beside(anchor.x, anchor.gapX, size.width, within.left, within.right),
    top: clamp(anchor.y + anchor.gapY, within.top, within.bottom - size.height),
  };
}

/** The width a tooltip may take for `anchor`: its box's, when it has to stay in one. */
export function tooltipRoom(anchor: TooltipAnchor | null): number | null {
  if (anchor === null || "control" in anchor || anchor.within === undefined) {
    return null;
  }
  return Math.max(0, Math.floor(anchor.within.right - anchor.within.left));
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
 * The ancestors that clip or scroll, per element. Finding them reads a computed style per
 * ancestor, which is too much for every pointer move in every chart of a dashboard; they change
 * with the layout at most, so a resize of the window and a change of page forget them.
 */
let clippersEpoch = 0;
const clippers = new WeakMap<Element, { epoch: number; found: Element[] }>();

/**
 * Forgets which ancestors clip. The router calls it after every navigation: another page may
 * put the same elements into other scroll boxes (a dashboard opened in the panel editor).
 */
export function forgetClippingAncestors(): void {
  clippersEpoch += 1;
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", forgetClippingAncestors);
}

function clippingAncestors(element: Element): Element[] {
  const known = clippers.get(element);
  if (known !== undefined && known.epoch === clippersEpoch) {
    return known.found;
  }
  const found: Element[] = [];
  const clips = (overflow: string) => overflow !== "" && overflow !== "visible";
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(parent);
    if (clips(overflowX) || clips(overflowY)) {
      found.push(parent);
    }
  }
  clippers.set(element, { epoch: clippersEpoch, found });
  return found;
}

/**
 * The part of `element` that is on screen: its box cut by the viewport, by every ancestor that
 * clips or scrolls and by the sticky bars it has scrolled under. `null` when nothing of it
 * shows, so a tooltip for a chart that is scrolled away does not hang over the page.
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
  for (const parent of clippingAncestors(element)) {
    const clip = parent.getBoundingClientRect();
    box.left = Math.max(box.left, clip.left);
    box.top = Math.max(box.top, clip.top);
    box.right = Math.min(box.right, clip.right);
    box.bottom = Math.min(box.bottom, clip.bottom);
  }
  // From the top down: a bar under another one covers what the first has left.
  const bars = [...document.querySelectorAll(`[${STICKY_BAR_ATTRIBUTE}]`)]
    .filter((bar) => !bar.contains(element))
    .map((bar) => bar.getBoundingClientRect())
    .sort((a, b) => a.top - b.top);
  for (const covered of bars) {
    // A bar over the top of the element, across it: what is under the bar does not show.
    if (covered.left < box.right && covered.right > box.left && covered.top <= box.top) {
      box.top = Math.max(box.top, covered.bottom);
    }
  }
  return box.right > box.left && box.bottom > box.top ? box : null;
}
