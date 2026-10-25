import { type KeyboardEvent, useEffect, useLayoutEffect } from "react";
import { placeMenu } from "../components/menuPlacement";
import type { useMenuButton } from "./useMenuButton";

/**
 * A menu drawn in the window (a portal at the end of the page) next to its button: placed when
 * it opens, closed when the window resizes or anything but the menu itself scrolls, and Tab
 * leaves it back at its button, since in the page's order it sits at the very end. Returns the
 * menu's key handler.
 */
export function useFloatingMenu(
  menu: ReturnType<typeof useMenuButton>,
  side: "below" | "beside" = "below",
) {
  const { open, buttonRef, menuRef, closeMenu, onMenuKeyDown } = menu;

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (open && button !== null && list !== null) {
      placeMenu(button, list, side);
    }
  }, [open, buttonRef, menuRef, side]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => closeMenu(false);
    // Captured, so a scrolling sidebar or panel closes it too, not only the page.
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target) === true) {
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
  }, [open, closeMenu, menuRef]);

  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    onMenuKeyDown(event);
  };
}
