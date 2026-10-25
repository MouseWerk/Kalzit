import { type RefObject, useEffect, useLayoutEffect } from "react";

const MARGIN = 8;
/** Below this much room under the button, a menu opens above it when that gives more. */
const FLIP_BELOW = 240;

/** Puts a menu drawn in the window next to its button, kept inside the window. */
function place(button: HTMLElement, list: HTMLElement): void {
  const box = button.getBoundingClientRect();
  const below = window.innerHeight - box.bottom - MARGIN;
  const above = box.top - MARGIN;
  const flip = below < FLIP_BELOW && above > below;
  list.style.setProperty("--menu-min", `${box.width}px`);
  list.style.setProperty("--menu-max-height", `${Math.max(flip ? above : below, 120)}px`);
  const left = Math.min(box.left, window.innerWidth - list.offsetWidth - MARGIN);
  list.style.setProperty("--menu-left", `${Math.max(left, MARGIN)}px`);
  if (flip) {
    const height = Math.min(list.offsetHeight, above);
    list.style.setProperty("--menu-top", `${Math.max(box.top - height, MARGIN)}px`);
  } else {
    list.style.setProperty("--menu-top", `${box.bottom}px`);
  }
}

/**
 * Keeps a menu drawn in the window under (or, near the window's bottom, above) its button: placed
 * when it opens and again when `deps` change (a filtered list changes its width), moved along
 * with a scroll of the page, closed when the window's width changes (a phone keyboard that only
 * changes the height leaves it open). One place for the variable picker and the links menu.
 */
export function useMenuPlacement(
  open: boolean,
  buttonRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  close: () => void,
  deps: readonly unknown[],
): void {
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (open && button !== null && list !== null) {
      place(button, list);
    }
  }, [open, buttonRef, menuRef, ...deps]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        close();
      }
    };
    const onScroll = (event: Event) => {
      const button = buttonRef.current;
      const list = menuRef.current;
      // The menu's own list scrolls without moving it.
      if (button !== null && list !== null && !list.contains(event.target as Node)) {
        place(button, list);
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, buttonRef, menuRef, close]);
}
