import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectConsoleOutput } from "../test/console";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

function Failing({ fail }: { fail: boolean }) {
  if (fail) {
    // As the graph renderer does on a stage without a size.
    throw new Error("Container has no width");
  }
  return <p>drawn</p>;
}

describe("a panel that fails while drawing", () => {
  it("says so in its own place, beside the rest of the page, and draws again with new data", () => {
    expectConsoleOutput(/Container has no width/);
    const view = render(
      <div>
        <p>other panel</p>
        <PanelErrorBoundary resetKeys={[1]}>
          <Failing fail />
        </PanelErrorBoundary>
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "This panel could not be drawn. Reload the page, or open the panel in the editor to check its query and options.",
    );
    expect(screen.getByText("other panel")).toBeTruthy();
    view.rerender(
      <div>
        <p>other panel</p>
        <PanelErrorBoundary resetKeys={[2]}>
          <Failing fail={false} />
        </PanelErrorBoundary>
      </div>,
    );
    expect(screen.getByText("drawn")).toBeTruthy();
  });
});
