import type { Page } from "@playwright/test";

/** A system color keyword (`CanvasText`, `LinkText`, ...) as the browser resolves it now. */
export function systemColor(page: Page, keyword: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement("span");
    probe.style.setProperty("forced-color-adjust", "none");
    probe.style.setProperty("color", name);
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, keyword);
}
