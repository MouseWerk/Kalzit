import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Below this height (in rem) a graph panel shows the explorer's steps in their compact form: one
 * line, the settings of the next step behind a button. The full form needs about two thirds of
 * it; the rest stays for the drawing or the table.
 */
export const COMPACT_BELOW_REM = 28;

/** Whether a graph panel of this height (px; null before it is measured) is short. */
export function isShort(height: number | null, rem: number): boolean {
  return height !== null && height > 0 && height < COMPACT_BELOW_REM * rem;
}

function rootRem(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/**
 * Whether the element (the graph panel's root, as tall as its host makes it) is short. Without a
 * ResizeObserver (tests without a browser) nothing is measured and the panel is never short.
 */
export function useShortPanel(ref: RefObject<HTMLElement | null>): boolean {
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const measure = (height: number) => setShort(isShort(height, rootRem()));
    measure(element.clientHeight);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return short;
}
