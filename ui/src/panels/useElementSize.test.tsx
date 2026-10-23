import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useElementSize } from "./useElementSize";

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(ref);
  return (
    <div ref={ref}>
      <output>{`${width}x${height}`}</output>
    </div>
  );
}

type Callback = (entries: { contentRect: { width: number; height: number } }[]) => void;

describe("useElementSize", () => {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;

  afterEach(() => {
    scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  });

  it("renders a new size before the browser paints, not a frame later", () => {
    let notify: Callback = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: Callback) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Probe />);
    // A real observer calls back outside React, between layout and paint; act() would hide
    // whether the update is synchronous.
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    notify([{ contentRect: { width: 321, height: 123 } }]);
    // Read at once, with no await: a deferred render would still show the old size here.
    expect(screen.getByRole("status").textContent).toBe("321x123");
  });
});
