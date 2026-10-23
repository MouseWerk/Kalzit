import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useElementSize } from "./useElementSize";

function Probe({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(ref);
  return (
    <div ref={ref} data-probe={name}>
      <output aria-label={name}>{`${width}x${height}`}</output>
    </div>
  );
}

type Entry = { target: Element; contentRect: { width: number; height: number } };
type Callback = (entries: Entry[]) => void;

describe("useElementSize", () => {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;

  afterEach(() => {
    scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  });

  it("renders new sizes before the browser paints, all charts from one observer", () => {
    const callbacks: Callback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: Callback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const { container } = render(
      <>
        <Probe name="a" />
        <Probe name="b" />
      </>,
    );
    // One observer serves every measured element.
    expect(callbacks).toHaveLength(1);
    const target = (name: string) =>
      container.querySelector(`[data-probe="${name}"]`) as HTMLElement;
    // A real observer calls back outside React, between layout and paint; act() would hide
    // whether the update is synchronous.
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    callbacks[0]?.([
      { target: target("a"), contentRect: { width: 321, height: 123 } },
      { target: target("b"), contentRect: { width: 200, height: 100 } },
    ]);
    // Read at once, with no await: a deferred render would still show the old sizes here.
    expect(screen.getByRole("status", { name: "a" }).textContent).toBe("321x123");
    expect(screen.getByRole("status", { name: "b" }).textContent).toBe("200x100");
  });
});
