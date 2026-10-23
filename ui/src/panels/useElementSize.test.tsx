import { act, render, screen } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Measures an element another component renders. */
function Reader({ target, name }: { target: RefObject<HTMLDivElement | null>; name: string }) {
  const { width, height } = useElementSize(target);
  return <output aria-label={name}>{`${width}x${height}`}</output>;
}

/** One box and two hooks that measure it; either may go away first. */
function Shared({ a, b }: { a: boolean; b: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref} data-probe="box" />
      {a ? <Reader target={ref} name="a" /> : null}
      {b ? <Reader target={ref} name="b" /> : null}
    </>
  );
}

type Entry = { target: Element; contentRect: { width: number; height: number } };
type Callback = (entries: Entry[]) => void;

/**
 * What the observer was asked to do. The hook keeps one observer for the whole module, so the
 * stub records into this object, which each test resets.
 */
const seen = {
  callbacks: [] as Callback[],
  observed: [] as Element[],
  unobserved: [] as Element[],
};

class FakeObserver {
  constructor(callback: Callback) {
    seen.callbacks.push(callback);
  }
  observe(element: Element) {
    seen.observed.push(element);
  }
  unobserve(element: Element) {
    seen.unobserved.push(element);
  }
  disconnect() {}
}

describe("useElementSize", () => {
  const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
  // The module keeps one observer, made on the first measurement in this file.
  const deliver: Callback = (entries) => seen.callbacks[0]?.(entries);

  beforeEach(() => {
    seen.observed.length = 0;
    seen.unobserved.length = 0;
    vi.stubGlobal("ResizeObserver", FakeObserver);
  });

  afterEach(() => {
    scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  });

  it("renders new sizes before the browser paints, all charts from one observer", () => {
    const { container } = render(
      <>
        <Probe name="a" />
        <Probe name="b" />
      </>,
    );
    // One observer serves every measured element.
    expect(seen.callbacks).toHaveLength(1);
    const target = (name: string) =>
      container.querySelector(`[data-probe="${name}"]`) as HTMLElement;
    // A real observer calls back outside React, between layout and paint; act() would hide
    // whether the update is synchronous.
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    deliver([
      { target: target("a"), contentRect: { width: 321, height: 123 } },
      { target: target("b"), contentRect: { width: 200, height: 100 } },
    ]);
    // Read at once, with no await: a deferred render would still show the old sizes here.
    expect(screen.getByRole("status", { name: "a" }).textContent).toBe("321x123");
    expect(screen.getByRole("status", { name: "b" }).textContent).toBe("200x100");
  });

  it.each([
    ["a", "b"],
    ["b", "a"],
  ] as const)(
    "keeps a shared element observed until both hooks are gone (%s first)",
    (first, last) => {
      const shown = { a: true, b: true };
      const { container, rerender } = render(<Shared {...shown} />);
      const box = container.querySelector('[data-probe="box"]') as HTMLElement;
      // Observed once, for both hooks.
      expect(seen.observed.filter((element) => element === box)).toHaveLength(1);

      shown[first] = false;
      rerender(<Shared {...shown} />);
      expect(seen.unobserved).not.toContain(box);
      // The remaining hook still gets the new size.
      act(() => deliver([{ target: box, contentRect: { width: 300, height: 150 } }]));
      expect(screen.getByRole("status", { name: last }).textContent).toBe("300x150");

      shown[last] = false;
      rerender(<Shared {...shown} />);
      expect(seen.unobserved.filter((element) => element === box)).toHaveLength(1);
    },
  );
});
