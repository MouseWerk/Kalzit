/**
 * Scrolls `container` just far enough that `element` inside it is fully visible, and touches
 * nothing else: `scrollIntoView` would also scroll the page, which moves a section the reader is
 * looking at. A navigation taller than the window uses it to keep its current entry in view.
 */
export function revealInside(container: HTMLElement, element: HTMLElement): void {
  const box = container.getBoundingClientRect();
  const item = element.getBoundingClientRect();
  if (item.top < box.top) {
    container.scrollTop -= box.top - item.top;
  } else if (item.bottom > box.bottom) {
    container.scrollTop += Math.min(item.bottom - box.bottom, item.top - box.top);
  }
}
