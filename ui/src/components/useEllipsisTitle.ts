import { useLayoutEffect, useRef, useState } from "react";

/**
 * The elements being watched, each with the check that measures it anew. One list for all of
 * them: a long table has a cut text in every row, and one observer and one font listener serve
 * them all.
 */
const checks = new Map<Element, () => void>();
let observer: ResizeObserver | undefined;
let watchedFonts: FontFaceSet | undefined;

/**
 * A web font that arrives after the first paint changes how wide a text is without changing
 * its element's box, so no resize is reported: every text is measured again once fonts loaded.
 */
function watchFonts() {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (fonts === undefined || fonts === watchedFonts) {
    return;
  }
  watchedFonts = fonts;
  fonts.addEventListener("loadingdone", () => {
    for (const check of [...checks.values()]) {
      check();
    }
  });
}

/** Calls `check` when the element's size or the loaded fonts change, until the return is called. */
function watch(element: Element, check: () => void): () => void {
  checks.set(element, check);
  watchFonts();
  if (typeof ResizeObserver !== "undefined") {
    observer ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        checks.get(entry.target)?.();
      }
    });
    observer.observe(element);
  }
  return () => {
    checks.delete(element);
    observer?.unobserve(element);
  };
}

/**
 * The `title` of a text that may end in an ellipsis: the whole text while the element cuts it,
 * none while it fits (a tooltip that repeats what is on screen is noise). Measured on the
 * element, not guessed from the text's length, so it follows the width, the font and the
 * language. The ref goes on the element that carries `text-overflow: ellipsis`.
 */
export function useEllipsisTitle<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is measured anew
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const check = () => setCut(element.scrollWidth > element.clientWidth + 1);
    check();
    return watch(element, check);
  }, [text]);
  return { ref, title: cut ? text : undefined };
}
