/** The gap between a menu and the window's edge, in pixels. */
const EDGE_PX = 8;
/** The gap between a menu and its button, in pixels. */
const GAP_PX = 4;

/**
 * Places a menu drawn in the window (position: fixed, through --menu-top, --menu-left) next to
 * its button. "below" puts it under the button, its right edge on the button's; "beside" puts it
 * to the right of the button, its top on the button's (a menu in the sidebar). Either flips when
 * the window's edge is near: up instead of down, left instead of right, and stays inside.
 */
export function placeMenu(
  button: HTMLElement,
  list: HTMLElement,
  side: "below" | "beside" = "below",
): void {
  const box = button.getBoundingClientRect();
  const { width, height } = list.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - EDGE_PX;
  const maxTop = window.innerHeight - height - EDGE_PX;
  let left: number;
  let top: number;
  if (side === "beside") {
    left =
      box.right + GAP_PX + width + EDGE_PX <= window.innerWidth
        ? box.right + GAP_PX
        : box.left - GAP_PX - width;
    top = box.top + height + EDGE_PX <= window.innerHeight ? box.top : box.bottom - height;
    // No room on either side (a phone): under the button instead.
    if (left < EDGE_PX) {
      left = box.right - width;
      top = box.bottom + GAP_PX;
    }
  } else {
    left = box.right - width;
    top =
      box.bottom + GAP_PX + height + EDGE_PX <= window.innerHeight
        ? box.bottom + GAP_PX
        : box.top - GAP_PX - height;
  }
  list.style.setProperty("--menu-left", `${Math.max(Math.min(left, maxLeft), EDGE_PX)}px`);
  list.style.setProperty("--menu-top", `${Math.max(Math.min(top, maxTop), EDGE_PX)}px`);
}
