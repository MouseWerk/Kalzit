import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { placeMenu } from "../components/menuPlacement";
import type { useMenuButton } from "./useMenuButton";

/**
 * A menu drawn in the window (a portal at the end of the page) next to its button: placed when
 * it opens, closed when the window resizes or a scroll moves its button away from where the menu
 * was placed, and Tab leaves it back at its button, since in the page's order it sits at the very
 * end. Returns the menu's key handler.
 */
export function useFloatingMenu(
  menu: ReturnType<typeof useMenuButton>,
  side: "below" | "beside" = "below",
) {
  const { open, buttonRef, menuRef, closeMenu, onMenuKeyDown } = menu;
  // Where the button was when the menu was placed next to it.
  const placedAt = useRef<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (open && button !== null && list !== null) {
      placeMenu(button, list, side);
      const box = button.getBoundingClientRect();
      placedAt.current = { top: box.top, left: box.left };
    } else {
      placedAt.current = null;
    }
  }, [open, buttonRef, menuRef, side]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => closeMenu(false);
    // Captured, so a scrolling sidebar or panel closes it too, not only the page. Only a scroll
    // that moved the button counts: the browser sends scroll events a frame late, so the event of
    // a scroll that ended before the menu opened (the button scrolled into view right before
    // the click) would otherwise close a menu that still sits right next to its button.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) === true) {
        return;
      }
      const box = buttonRef.current?.getBoundingClientRect();
      const at = placedAt.current;
      if (box !== undefined && at !== null && box.top === at.top && box.left === at.left) {
        return;
      }
      close();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, closeMenu, menuRef, buttonRef]);

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    onMenuKeyDown(event);
  };
}
