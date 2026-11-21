/**
 * Whether a span's detail lies over the whole waterfall: the sheet of a narrow window, or the
 * overlay of a dashboard panel no wider than the overlay itself (trace.css). What it covers
 * cannot be seen, so it must not be reached by pointer or keyboard either.
 */
export function coversWaterfall(sheet: HTMLElement, behind: HTMLElement): boolean {
  if (getComputedStyle(sheet).position !== "absolute") {
    return false;
  }
  const over = sheet.getBoundingClientRect();
  const under = behind.getBoundingClientRect();
  return under.width > 0 && over.left <= under.left + 1 && over.right >= under.right - 1;
}
