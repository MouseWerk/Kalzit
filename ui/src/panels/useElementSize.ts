import { type RefObject, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

export interface Size {
  width: number;
  height: number;
}

/** Used until the first measurement, and where there is no layout (tests without a browser). */
export const FALLBACK_SIZE: Size = { width: 640, height: 220 };

type Measure = (width: number, height: number) => void;

/**
 * One observer for every measured element, created on first use. A delivery holds all elements
 * that changed in that frame; their sizes render together in one flushSync, so a dashboard with
 * many charts renders once per frame, not once per chart.
 */
let shared: ResizeObserver | null = null;
// Handlers per element: two hooks may measure the same element; it stays observed until the
// last of them is gone.
const measures = new Map<Element, Set<Measure>>();

function observer(): ResizeObserver {
  shared ??= new ResizeObserver((entries) => {
    flushSync(() => {
      for (const entry of entries) {
        const box = entry.contentRect;
        for (const measure of measures.get(entry.target) ?? []) {
          measure(Math.floor(box.width), Math.floor(box.height));
        }
      }
    });
  });
  return shared;
}

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
    const measure: Measure = (width, height) => {
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
    const resize = observer();
    let handlers = measures.get(element);
    if (handlers === undefined) {
      handlers = new Set();
      measures.set(element, handlers);
      resize.observe(element);
    }
    handlers.add(measure);
    return () => {
      handlers.delete(measure);
      if (handlers.size === 0) {
        measures.delete(element);
        resize.unobserve(element);
      }
    };
  }, [ref]);
  return size;
}
