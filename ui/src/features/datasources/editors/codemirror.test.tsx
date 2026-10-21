import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { sqlCompletions } from "./completion";

// CodeMirror measures text through Range rectangles, which jsdom does not lay out. Empty
// rectangles are enough for it to run; nothing here depends on positions.
const { getClientRects, getBoundingClientRect } = Range.prototype;
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Range.prototype.getClientRects = getClientRects;
  Range.prototype.getBoundingClientRect = getBoundingClientRect;
});

function viewOf(textbox: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(textbox);
  if (view === null) {
    throw new Error("no editor");
  }
  return view;
}

describe("CodeMirror query editor", () => {
  it("names the text, reports changes, runs on Ctrl+Enter and follows the value", async () => {
    const onChange = vi.fn();
    const onRun = vi.fn();
    const { rerender } = render(
      <CodeMirrorEditor
        language="sql"
        label="Query A"
        describedBy="hint"
        value="SELECT 1"
        onChange={onChange}
        onRun={onRun}
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Query A" });
    expect(textbox.getAttribute("aria-describedby")).toBe("hint");
    const view = viewOf(textbox);
    expect(view.state.doc.toString()).toBe("SELECT 1");

    view.dispatch({ changes: { from: 8, insert: "0" } });
    expect(onChange).toHaveBeenLastCalledWith("SELECT 10");

    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(onRun).toHaveBeenCalledTimes(1);

    rerender(
      <CodeMirrorEditor
        language="sql"
        label="Query A"
        value="SELECT 2"
        onChange={onChange}
        onRun={onRun}
      />,
    );
    expect(view.state.doc.toString()).toBe("SELECT 2");
  });

  it("marks tokens with the same classes as the plain editor", async () => {
    render(
      <CodeMirrorEditor
        language="sql"
        label="Query"
        value="SELECT 'a' -- note"
        onChange={() => undefined}
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Query" });
    await waitFor(() =>
      expect(textbox.querySelector(".code-token--keyword")?.textContent).toBe("SELECT"),
    );
    expect(textbox.querySelector(".code-token--string")?.textContent).toBe("'a'");
    expect(textbox.querySelector(".code-token--comment")?.textContent).toBe("-- note");
  });

  it("offers schema completions through CodeMirror", async () => {
    const schema = {
      kind: "tables" as const,
      tables: [{ name: "orders", columns: [{ name: "amount", type: "numeric" }] }],
    };
    render(
      <CodeMirrorEditor
        language="sql"
        label="Query"
        value="SELECT am FROM orders"
        onChange={() => undefined}
        complete={(text, cursor, explicit) => sqlCompletions(text, cursor, schema, explicit)}
      />,
    );
    const view = viewOf(await screen.findByRole("textbox", { name: "Query" }));
    view.dispatch({ selection: { anchor: 9 } });
    const { startCompletion } = await import("@codemirror/autocomplete");
    startCompletion(view);
    expect(await screen.findByRole("option", { name: /amount/ })).toBeTruthy();
  });

  it("closes the suggestions when Ctrl+Enter runs the query", async () => {
    const onRun = vi.fn();
    const schema = {
      kind: "tables" as const,
      tables: [{ name: "orders", columns: [{ name: "amount", type: "numeric" }] }],
    };
    render(
      <CodeMirrorEditor
        language="sql"
        label="Query"
        value="SELECT am FROM orders"
        onChange={() => undefined}
        onRun={onRun}
        complete={(text, cursor, explicit) => sqlCompletions(text, cursor, schema, explicit)}
      />,
    );
    const textbox = await screen.findByRole("textbox", { name: "Query" });
    const view = viewOf(textbox);
    view.dispatch({ selection: { anchor: 9 } });
    const { completionStatus, startCompletion } = await import("@codemirror/autocomplete");
    startCompletion(view);
    await screen.findByRole("option", { name: /amount/ });
    fireEvent.keyDown(textbox, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(completionStatus(view.state)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("option", { name: /amount/ })).toBeNull());
  });
});
