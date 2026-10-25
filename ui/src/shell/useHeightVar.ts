import { type RefObject, useLayoutEffect } from "react";

/**
 * Publishes an element's height as a custom property on the root, so sticky parts below it
 * (the dashboard toolbar under the top bar, the settings navigation, the rail) and anchor jumps
 * (scroll-padding) know where the visible page starts. The property is removed on unmount.
 */
export function useHeightVar(ref: RefObject<HTMLElement | null>, name: `--${string}`) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const root = document.documentElement;
    const publish = () => root.style.setProperty(name, `${element.offsetHeight}px`);
    publish();
    // jsdom has no ResizeObserver; every browser has.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(name);
    };
  }, [ref, name]);
}
