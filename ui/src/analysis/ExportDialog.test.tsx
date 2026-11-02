import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ExportChoice, ExportDialog, type ExportResult, exportResults } from "./ExportDialog";

/** An export that never answers, to see what closing the dialog does to it. */
function hanging() {
  const seen: { choice?: ExportChoice; signal?: AbortSignal } = {};
  const run = (choice: ExportChoice, signal: AbortSignal) => {
    seen.choice = choice;
    seen.signal = signal;
    return new Promise<never>(() => {});
  };
  return { seen, run };
}

const tables = (...names: string[]): ExportResult[] =>
  names.map((name) => ({ name, shape: "frame" }));

describe("export dialog", () => {
  it("sends the chosen format and number style", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    render(<ExportDialog results={tables("A", "B")} run={run} onClose={() => {}} />);
    await user.click(screen.getByRole("radio", { name: /German/ }));
    await user.selectOptions(screen.getByLabelText("Result"), "B");
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(seen.choice).toEqual({ format: "csv", language: "de", frame: "B" });
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeTruthy();
  });

  it("cancels the running export when it is closed", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    let closed = 0;
    render(<ExportDialog results={tables("A")} run={run} onClose={() => closed++} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(seen.signal?.aborted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(seen.signal?.aborted).toBe(true);
    expect(closed).toBe(1);
  });

  it("cancels the running export when it goes away", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    const view = render(<ExportDialog results={tables("A")} run={run} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    view.unmount();
    expect(seen.signal?.aborted).toBe(true);
  });

  it("offers the formats of each shape and keeps its own shape", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    const results: ExportResult[] = [
      { name: "A", shape: "frame" },
      { name: "B", shape: "documents" },
      { name: "C", shape: "graph" },
    ];
    render(<ExportDialog results={results} run={run} onClose={() => {}} />);
    const formats = () => screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value);
    expect(formats()).toEqual(["csv", "xlsx", "json", "de", "en"]);
    await user.selectOptions(screen.getByLabelText("Result"), "B");
    // Documents are no table: no CSV or Excel, and no number style.
    expect(formats()).toEqual(["ndjson", "json"]);
    expect(screen.getByRole("radio", { name: /NDJSON/ })).toHaveProperty("checked", true);
    expect(screen.getByText(/add a step that makes a table/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Result"), "C");
    expect(formats()).toEqual(["graphml", "json"]);
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(seen.choice).toEqual({ format: "json", language: "en", frame: "C" });
  });

  it("names each result with its shape", () => {
    const results = exportResults({
      frames: [{ name: "B", frame: { fields: [] } }],
      documents: [{ name: "A", documents: { documents: [], schema: [], notices: [] } }],
      graphs: [
        {
          name: "C",
          graph: {
            nodes: [],
            edges: [],
            schema: { labels: [], edgeTypes: [], propertyKeys: {} },
          },
        },
      ],
    });
    // Tables first, as the server picks them when the request names none.
    expect(results).toEqual([
      { name: "B", shape: "frame" },
      { name: "A", shape: "documents" },
      { name: "C", shape: "graph" },
    ]);
    render(<ExportDialog results={results} run={hanging().run} onClose={() => {}} />);
    expect(screen.getByRole("option", { name: "A (documents)" })).toBeTruthy();
  });
});
