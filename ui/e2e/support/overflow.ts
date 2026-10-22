import type { Page } from "@playwright/test";

export interface Overflow {
  /** The page's scroll width and the viewport width. */
  scrollWidth: number;
  width: number;
  /** Elements that stick out, worst first: "tag.class reaches 512 px, allowed 360 px". */
  offenders: string[];
}

/**
 * Finds elements that stick out to the right. On the page, an element may not reach past the
 * viewport, unless an ancestor clips or scrolls it on purpose (a table in a scrolling frame, a
 * truncated label). Inside an open dialog nothing may reach past the dialog's edge: a dialog
 * that clips its content hides part of it, so only deliberate horizontal scrollers (overflow-x
 * auto or scroll, such as the query editor) may hold wider content.
 */
export function findOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]')];
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()}${[...element.classList].map((c) => `.${c}`).join("")}`;
    const found: { text: string; by: number }[] = [];

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
      // Ancestors that keep the element inside on purpose. A dialog itself always has to fit.
      let exempt = false;
      const isDialog = dialogs.includes(element as HTMLElement);
      for (
        let a = isDialog ? null : element.parentElement;
        a !== null && a !== dialog;
        a = a.parentElement
      ) {
        const overflowX = getComputedStyle(a).overflowX;
        const scrolls = overflowX === "auto" || overflowX === "scroll";
        if (scrolls || (dialog === undefined && overflowX !== "visible")) {
          exempt = true;
          break;
        }
      }
      if (!exempt && rect.right > limit + 0.5) {
        found.push({
          text: `${describe(element)} reaches ${Math.round(rect.right)} px, allowed ${Math.round(limit)} px`,
          by: rect.right - limit,
        });
      }
    }
    found.sort((a, b) => b.by - a.by);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      width,
      offenders: found.slice(0, 5).map((f) => f.text),
    };
  });
}
