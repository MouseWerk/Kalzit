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
  // What a browser does under `style-src 'self'`: the inline style element gets no sheet.
  Object.defineProperty(HTMLStyleElement.prototype, "sheet", {
    configurable: true,
    get: () => null,
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

describe("editor styles under the content security policy", () => {
  it("mirrors CodeMirror's refused style element into a constructed sheet and keeps it in sync", async () => {
    // Stubbed here: globals stubbed before the test are reset for each test.
    vi.stubGlobal("CSSStyleSheet", RecordingSheet);
    const theme = EditorView.theme({ "&": { color: "var(--text)" } });
    const view = withEditorStyles(
      document,
      () => new EditorView({ parent: document.body, doc: "SELECT 1", extensions: [theme] }),
    );
    const adopted = document.adoptedStyleSheets as unknown as RecordingSheet[];
    expect(adopted).toHaveLength(1);
    const style = [...document.head.querySelectorAll("style")].at(-1);
    expect(adopted[0]?.text).toBe(style?.textContent);
    expect(adopted[0]?.text).toContain("cm-scroller");
    expect(adopted[0]?.text).toContain("var(--text)");

    // A later editor with a new theme adds rules to the same element; the sheet follows.
    const later = EditorView.theme({ "&": { color: "var(--text-muted)" } });
    const second = withEditorStyles(
      document,
      () => new EditorView({ parent: document.body, doc: "SELECT 2", extensions: [later] }),
    );
    await vi.waitFor(() => expect(adopted[0]?.text).toContain("var(--text-muted)"));
    expect(document.adoptedStyleSheets).toHaveLength(1);
    second.destroy();
    view.destroy();
  });
});
