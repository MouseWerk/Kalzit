import { type RefObject, useLayoutEffect, useState } from "react";

export interface Size {
  width: number;
  height: number;
}

/** Used until the first measurement, and where there is no layout (tests without a browser). */
export const FALLBACK_SIZE: Size = { width: 640, height: 220 };

/** The element's content size, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(FALLBACK_SIZE);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = (width: number, height: number) => {
      if (width > 0 && height > 0) {
        setSize((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      }
    };
    const rect = element.getBoundingClientRect();
    measure(Math.floor(rect.width), Math.floor(rect.height));
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) {
        measure(Math.floor(box.width), Math.floor(box.height));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
