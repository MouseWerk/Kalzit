import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ExportChoice, ExportDialog } from "./ExportDialog";

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

describe("export dialog", () => {
  it("sends the chosen format and number style", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    render(<ExportDialog frames={["A", "B"]} run={run} onClose={() => {}} />);
    await user.click(screen.getByRole("radio", { name: /German/ }));
    await user.selectOptions(screen.getByLabelText("Table"), "B");
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(seen.choice).toEqual({ format: "csv", language: "de", frame: "B" });
    expect(screen.getByRole("button", { name: "Exporting…" })).toBeTruthy();
  });

  it("cancels the running export when it is closed", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    let closed = 0;
    render(<ExportDialog frames={["A"]} run={run} onClose={() => closed++} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(seen.signal?.aborted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(seen.signal?.aborted).toBe(true);
    expect(closed).toBe(1);
  });

  it("cancels the running export when it goes away", async () => {
    const user = userEvent.setup();
    const { seen, run } = hanging();
    const view = render(<ExportDialog frames={["A"]} run={run} onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    view.unmount();
    expect(seen.signal?.aborted).toBe(true);
  });
});
