import { act } from "@testing-library/react";
import { vi } from "vitest";

/**
 * jsdom has no matchMedia, so the shell assumes the wide column layout. This answers every
 * media query with `matches`, for tests of the narrow (bar on top) layout, and `set` changes the
 * answer as a resized window would; vi.unstubAllGlobals removes it.
 */
export function stubMatchMedia(initial: boolean): { set: (matches: boolean) => void } {
  let matches = initial;
  const target = new EventTarget();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  }));
  return {
    set(next) {
      matches = next;
      act(() => {
        target.dispatchEvent(new Event("change"));
      });
    },
  };
}
