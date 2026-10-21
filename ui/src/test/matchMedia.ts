import { act } from "@testing-library/react";
import { vi } from "vitest";
import { WIDE_QUERY } from "../shell/sidebarState";

/**
 * jsdom has no matchMedia, so the shell assumes the wide column layout. This answers the shell's
 * WIDE_QUERY with `matches` (any other query does not match), for tests of the narrow (bar on
 * top) layout, and `set` changes the answer as a resized window would. Vitest removes the stub
 * after each test (unstubGlobals).
 */
export function stubMatchMedia(initial: boolean): { set: (matches: boolean) => void } {
  let matches = initial;
  const target = new EventTarget();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === WIDE_QUERY && matches;
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
