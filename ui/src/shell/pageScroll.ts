/**
 * Next to the sidebar the page scrolls in the main area, not the document (components.css).
 * Browsers send the scroll keys to the document while nothing has focus, as on a freshly opened
 * page, and the document no longer scrolls: the keys are passed on to the main area here (or to
 * the dashboard in kiosk mode, which covers it). Once something inside has focus, the browser
 * scrolls the right box itself.
 */

/** One arrow key's step, as in the browsers. */
export const LINE_STEP_PX = 40;

export type ScrollStep = number | "start" | "end";

/**
 * How far a key scrolls a box of `view` px whose top `cover` px lie under sticky bars: a line, a
 * page less one line (so the last line seen stays in view below the bars), or to an end. `null`
 * for keys that do not scroll.
 */
export function scrollStep(
  key: string,
  shift: boolean,
  view: number,
  cover: number,
): ScrollStep | null {
  const page = Math.max(LINE_STEP_PX, view - cover - LINE_STEP_PX);
  switch (key) {
    case "ArrowDown":
      return LINE_STEP_PX;
    case "ArrowUp":
      return -LINE_STEP_PX;
    case "PageDown":
      return page;
    case "PageUp":
      return -page;
    case " ":
      return shift ? -page : page;
    case "Home":
      return "start";
    case "End":
      return "end";
    default:
      return null;
  }
}

/**
 * Scrolls the page's scroll container for a scroll key pressed while nothing has focus. True
 * when it did (the key's default is then prevented); false leaves the key to the browser.
 */
export function scrollPageByKey(event: KeyboardEvent, main: HTMLElement | null): boolean {
  if (
    main === null ||
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (event.target !== document.body && event.target !== document.documentElement)
  ) {
    return false;
  }
  const box = document.querySelector<HTMLElement>(".dashboard--kiosk") ?? main;
  const style = getComputedStyle(box);
  // On a phone and in print the document scrolls itself.
  if (style.overflowY !== "auto" && style.overflowY !== "scroll") {
    return false;
  }
  const cover = Number.parseFloat(style.scrollPaddingBlockStart) || 0;
  const step = scrollStep(event.key, event.shiftKey, box.clientHeight, cover);
  if (step === null) {
    return false;
  }
  event.preventDefault();
  if (step === "start") {
    box.scrollTo({ top: 0 });
  } else if (step === "end") {
    box.scrollTo({ top: box.scrollHeight });
  } else {
    box.scrollBy({ top: step });
  }
  return true;
}
