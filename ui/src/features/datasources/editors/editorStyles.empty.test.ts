import { EditorView } from "@codemirror/view";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withEditorStyles } from "./editorStyles";

// jsdom has no constructed style sheets; this stand-in records what goes into one.
class RecordingSheet {
  text = "";
  replaceSync(text: string) {
    this.text = text;
  }
}

const sheetGetter = Object.getOwnPropertyDescriptor(HTMLStyleElement.prototype, "sheet");
const { getClientRects, getBoundingClientRect } = Range.prototype;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // Some browsers refuse the element under the CSP but still give it a sheet, an empty one.
  Object.defineProperty(HTMLStyleElement.prototype, "sheet", {
    configurable: true,
    get: () => ({ cssRules: [] }),
  });
  Object.defineProperty(document, "adoptedStyleSheets", { value: [], writable: true });
});
afterAll(() => {
  Range.prototype.getClientRects = getClientRects;
  Range.prototype.getBoundingClientRect = getBoundingClientRect;
  if (sheetGetter !== undefined) {
    Object.defineProperty(HTMLStyleElement.prototype, "sheet", sheetGetter);
  }
  vi.unstubAllGlobals();
});

describe("editor styles refused into an empty sheet", () => {
  it("mirrors them as well", () => {
    vi.stubGlobal("CSSStyleSheet", RecordingSheet);
    const view = withEditorStyles(
      document,
      () => new EditorView({ parent: document.body, doc: "SELECT 1" }),
    );
    const adopted = document.adoptedStyleSheets as unknown as RecordingSheet[];
    expect(adopted).toHaveLength(1);
    expect(adopted[0]?.text).toContain("cm-scroller");
    view.destroy();
  });
});
