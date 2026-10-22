import { render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";

// CodeEditor decides at import whether CodeMirror can run (it needs Range rectangles, which jsdom
// lacks), so the stand-ins go in first and the module is imported afterwards.
const { getClientRects, getBoundingClientRect } = Range.prototype;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterAll(() => {
  Range.prototype.getClientRects = getClientRects;
  Range.prototype.getBoundingClientRect = getBoundingClientRect;
});

describe("preloading the query editor", () => {
  it("shows CodeMirror at once, without the plain editor in between, once preloaded", async () => {
    const { CodeEditor, preloadCodeEditor } = await import("./CodeEditor");
    await preloadCodeEditor();
    const { container } = render(
      <CodeEditor language="sql" label="Query" value="SELECT 1" onChange={() => undefined} />,
    );
    // No swap from a text area that could take focus and a half-typed word with it.
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    expect(await screen.findByRole("textbox", { name: "Query" })).toBeTruthy();
  });
});
