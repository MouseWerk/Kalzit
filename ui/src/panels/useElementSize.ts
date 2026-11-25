import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { rootRem } from "./measure";

export interface Size {
  width: number;
  height: number;
}

/** A measured box, with the root font size (px per rem) read when it was measured. */
export interface ElementSize extends Size {
  rem: number;
}

/** Used until the first measurement, and where there is no layout (tests without a browser). */
export const FALLBACK_SIZE: Size = { width: 640, height: 220 };

/** The root font size until the first measurement: the browsers' default. */
const FALLBACK_REM = 16;

type Measure = (width: number, height: number, rem: number) => void;

/**
 * Sizes are whole pixels, rounded down, except for a box a few layout units (1/64 px each) short
 * of a whole pixel, which counts as that pixel. Chrome sizes the tracks of the dashboard grid in
 * layout units and hands the remainder to other columns as the drag placeholder moves, so a
 * panel's box goes from 256 to 255.984 px and back on every cell the placeholder passes; rounded
 * down plainly, each of those redrew the charts of the whole column during the drag (long tasks
 * of 35 to 60 ms at 4x CPU throttling).
 */
const SUBPIXEL = 0.05;

function whole(value: number): number {
  return Math.floor(value + SUBPIXEL);
}

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
    // Read here, between layout and paint, where styles are up to date and reading costs
    // nothing; read during a render it would restyle the page at once, after a drop the whole
    // dashboard in one long task. A new root font size (another density) resizes the boxes, so
    // it arrives here too.
    const rem = rootRem();
    flushSync(() => {
      for (const entry of entries) {
        const box = entry.contentRect;
        for (const measure of measures.get(entry.target) ?? []) {
          measure(whole(box.width), whole(box.height), rem);
        }
      }
    });
  });
  return shared;
}

/** Stops measuring an element for one hook; the element stays observed while others measure it. */
function release(element: Element, measure: Measure): void {
  const handlers = measures.get(element);
  if (handlers === undefined) {
    return;
  }
  handlers.delete(measure);
  if (handlers.size === 0) {
    measures.delete(element);
    shared?.unobserve(element);
  }
}

/**
 * The element's content size, kept current with a ResizeObserver. A new size renders before the
 * browser paints (flushSync in the observer's callback, which runs between layout and paint), so a
 * chart is never shown for a frame at its old size while a panel or the window is resized.
 *
 * The element is looked up after every commit, not only on mount: a chart's box often appears
 * later than the hook (inside a render prop, or once the first rows arrive after an empty
 * state), and a box measured only on mount would keep the fallback size for good. The observer
 * also reports the box once its layout has settled (the dashboard grid places panels in its own
 * layout effects, after the charts inside them measured), so a stale first size lasts no frame.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ ...FALLBACK_SIZE, rem: FALLBACK_REM });
  const observed = useRef<{ element: Element; measure: Measure } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const current = observed.current;
    if (current?.element === element) {
      return;
    }
    if (current !== null) {
      release(current.element, current.measure);
      observed.current = null;
    }
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    // Each side on its own: a box without height yet (its layout still settling) must not keep
    // a stale width, or a chart stays 640 px wide on a 360 px screen.
    const measure: Measure = (width, height, rem) => {
      setSize((last) => {
        const next = {
          width: width > 0 ? width : last.width,
          height: height > 0 ? height : last.height,
          rem,
        };
        return next.width === last.width && next.height === last.height && next.rem === last.rem
          ? last
          : next;
      });
    };
    // The box's layout is current after this read, so the root font size costs nothing more.
    const rect = element.getBoundingClientRect();
    measure(whole(rect.width), whole(rect.height), rootRem());
    const resize = observer();
    let handlers = measures.get(element);
    if (handlers === undefined) {
      handlers = new Set();
      measures.set(element, handlers);
      resize.observe(element);
    }
    handlers.add(measure);
    observed.current = { element, measure };
  });
  useLayoutEffect(
    () => () => {
      const current = observed.current;
      if (current !== null) {
        release(current.element, current.measure);
        observed.current = null;
      }
    },
    [],
  );
  return size;
}
