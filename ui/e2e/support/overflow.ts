import type { Page } from "@playwright/test";

export interface Overflow {
  /** The page's scroll width and the viewport width. */
  scrollWidth: number;
  width: number;
  /** Elements that stick out, innermost first: "tag.class reaches 512 px, allowed 360 px". */
  offenders: string[];
}

/** The scrolling body of each dialog kind; it scrolls vertically, never sideways. */
export const DIALOG_BODIES = ".dialog__body, .admin-dialog__body";

/**
 * Finds elements that stick out to the right.
 * - On the page, an element may not reach past the viewport, unless an ancestor clips or scrolls
 *   it on purpose (a table in a scrolling frame, a truncated label).
 * - A dialog has to fit the viewport, and nothing in it may reach past its edge. Its body scrolls
 *   vertically, so it must not scroll sideways either: its scroll width may not exceed its
 *   width. Only scrollers deeper inside (the query editor, a table frame) may hold wider content.
 */
export function findOverflow(page: Page): Promise<Overflow> {
  return page.evaluate((bodies) => {
    const width = document.documentElement.clientWidth;
    const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]')];
    const describeElement = (element: Element) =>
      `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join("")}`;
    const found: { element: Element; text: string; by: number }[] = [];

    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        continue;
      }
      const dialog = dialogs.find((d) => d !== element && d.contains(element));
      let limit = width;
      if (dialog !== undefined) {
        limit = Math.min(limit, dialog.getBoundingClientRect().right);
      }
      // Ancestors that keep the element inside on purpose. A dialog itself always has to fit,
      // and a dialog's own body does not count as such an ancestor.
      let exempt = false;
      const isDialog = dialogs.includes(element as HTMLElement);
      for (
        let a = isDialog ? null : element.parentElement;
        a !== null && a !== dialog;
        a = a.parentElement
      ) {
        if (dialog !== undefined && a.matches(bodies)) {
          continue;
        }
        const overflowX = getComputedStyle(a).overflowX;
        const scrolls = overflowX === "auto" || overflowX === "scroll";
        if (scrolls || (dialog === undefined && overflowX !== "visible")) {
          exempt = true;
          break;
        }
      }
      if (!exempt && rect.right > limit + 0.5) {
        found.push({
          element,
          text: `${describeElement(element)} reaches ${Math.round(rect.right)} px, allowed ${Math.round(limit)} px`,
          by: rect.right - limit,
        });
      }
    }
    // A dialog body that can scroll sideways hides content, whatever made it wider.
    for (const dialog of dialogs) {
      for (const body of dialog.querySelectorAll<HTMLElement>(bodies)) {
        if (body.scrollWidth > body.clientWidth + 1) {
          found.push({
            element: body,
            text: `${describeElement(body)} scrolls sideways: ${body.scrollWidth} px of content in ${body.clientWidth} px`,
            by: body.scrollWidth - body.clientWidth,
          });
        }
      }
    }
    // Innermost first: the element that is too wide, not every container it widens.
    const innermost = (f: (typeof found)[number]) =>
      !found.some((other) => other !== f && f.element.contains(other.element));
    found.sort((a, b) => Number(innermost(b)) - Number(innermost(a)) || b.by - a.by);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      width,
      offenders: found.slice(0, 5).map((f) => f.text),
    };
  }, DIALOG_BODIES);
}
