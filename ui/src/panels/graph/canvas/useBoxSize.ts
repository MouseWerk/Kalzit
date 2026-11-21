import { useLayoutEffect, useState } from "react";

/**
 * An element's size in CSS px, followed while it changes; 0 x 0 before it is measured. Give the
 * returned `measure` to the element as its ref (alongside any other ref through a callback).
 */
export function useBoxSize(): {
  measure: (element: HTMLElement | null) => void;
  width: number;
  height: number;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) return;
    const set = (width: number, height: number) =>
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    set(element.clientWidth, element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) set(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { measure: setElement, ...size };
}
