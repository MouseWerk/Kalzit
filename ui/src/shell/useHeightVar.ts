import { type RefObject, useLayoutEffect } from "react";

/**
 * Publishes an element's height as a custom property on the root, so sticky parts below it
 * (the dashboard toolbar under the top bar, the settings navigation, the rail) and anchor jumps
 * (scroll-padding) know where the visible page starts. With `media`, the height counts only
 * while the query matches (where the element sticks); otherwise 0 is published. The property is
 * removed on unmount.
 */
export function useHeightVar(
  ref: RefObject<HTMLElement | null>,
  name: `--${string}`,
  media?: string,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const root = document.documentElement;
    // jsdom has no matchMedia or ResizeObserver; every browser has.
    const query =
      media === undefined || typeof window.matchMedia !== "function"
        ? null
        : window.matchMedia(media);
    const publish = () => {
      const height = query === null || query.matches ? element.getBoundingClientRect().height : 0;
      root.style.setProperty(name, `${height}px`);
    };
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(element);
    query?.addEventListener("change", publish);
    return () => {
      observer?.disconnect();
      query?.removeEventListener("change", publish);
      root.style.removeProperty(name);
    };
  }, [ref, name, media]);
}
