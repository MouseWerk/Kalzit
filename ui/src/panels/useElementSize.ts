import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

export interface Size {
  width: number;
  height: number;
}

/** Used until the first measurement, and where there is no layout (tests without a browser). */
export const FALLBACK_SIZE: Size = { width: 640, height: 220 };

/**
 * The element's content size, kept current with a ResizeObserver. A new size renders before the
 * browser paints (flushSync in the observer's callback, which runs between layout and paint), so a
 * chart is never shown for a frame at its old size while a panel or the window is resized.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(FALLBACK_SIZE);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    // Each side on its own: a box without height yet (its layout still settling) must not keep
    // a stale width, or a chart stays 640 px wide on a 360 px screen.
    const measure = (width: number, height: number) => {
      setSize((current) => {
        const next = {
          width: width > 0 ? width : current.width,
          height: height > 0 ? height : current.height,
        };
        return next.width === current.width && next.height === current.height ? current : next;
      });
    };
    const rect = element.getBoundingClientRect();
    measure(Math.floor(rect.width), Math.floor(rect.height));
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) {
        flushSync(() => measure(Math.floor(box.width), Math.floor(box.height)));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
