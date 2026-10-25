/** The gap between a menu and the window's edge, in pixels. */
const EDGE_PX = 8;
/** The gap between a menu and its button, in pixels. */
const GAP_PX = 4;

/** Under the button, or above it when there is no room below. */
function belowOrAbove(box: DOMRect, height: number, viewHeight: number): number {
  return box.bottom + GAP_PX + height + EDGE_PX <= viewHeight
    ? box.bottom + GAP_PX
    : box.top - GAP_PX - height;
}

/**
 * Places a menu drawn in the window (position: fixed, through --menu-top, --menu-left) next to
 * its button. "below" puts it under the button, its right edge on the button's; "beside" puts it
 * to the right of the button, its top on the button's (a menu in the sidebar). Either flips when
 * the window's edge is near: up instead of down, left instead of right, and stays inside the
 * visible area (without the scroll bar).
 */
export function placeMenu(
  button: HTMLElement,
  list: HTMLElement,
  side: "below" | "beside" = "below",
): void {
  const box = button.getBoundingClientRect();
  const { width, height } = list.getBoundingClientRect();
  const viewWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewHeight = document.documentElement.clientHeight || window.innerHeight;
  let left: number;
  let top: number;
  if (side === "beside") {
    left =
      box.right + GAP_PX + width + EDGE_PX <= viewWidth
        ? box.right + GAP_PX
        : box.left - GAP_PX - width;
    top = box.top + height + EDGE_PX <= viewHeight ? box.top : box.bottom - height;
    // No room on either side (a phone): under the button, or above it, instead.
    if (left < EDGE_PX) {
      left = box.right - width;
      top = belowOrAbove(box, height, viewHeight);
    }
  } else {
    left = box.right - width;
    top = belowOrAbove(box, height, viewHeight);
  }
  const maxLeft = viewWidth - width - EDGE_PX;
  const maxTop = viewHeight - height - EDGE_PX;
  list.style.setProperty("--menu-left", `${Math.max(Math.min(left, maxLeft), EDGE_PX)}px`);
  list.style.setProperty("--menu-top", `${Math.max(Math.min(top, maxTop), EDGE_PX)}px`);
}
