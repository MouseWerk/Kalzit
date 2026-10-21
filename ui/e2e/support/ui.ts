import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Replaces the text of the query editor inside `scope`. Waits for CodeMirror (it loads after
 * the page) and enters the text in one go, like a paste. No Escape afterwards: inside a dialog
 * it would close the dialog when no suggestion list is open.
 */
export async function fillQuery(scope: Page | Locator, text: string): Promise<void> {
  const editor = scope.locator(".cm-content").first();
  await expect(editor).toBeVisible();
  await editor.click();
  const page = "page" in scope ? scope.page() : scope;
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
  await expect(editor).toHaveText(text);
}
