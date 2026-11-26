import { useEffect, useState } from "react";

/**
 * The icon set loads on first use: a graph without icon rules never fetches it, and the drawing
 * and the page share one copy.
 */

export type IconSet = typeof import("./set");

let loaded: IconSet | null = null;
let pending: Promise<IconSet> | null = null;

export function loadIcons(): Promise<IconSet> {
  if (pending === null) {
    pending = import("./set").then(
      (set) => {
        loaded = set;
        return set;
      },
      (error: unknown) => {
        // A lost chunk is fetched again by the next use.
        pending = null;
        throw error;
      },
    );
  }
  return pending;
}

/** The set when it has loaded, without asking for it. */
export function iconsNow(): IconSet | null {
  return loaded;
}

/** The set, once loaded; null until then (and where it cannot be fetched). */
export function useIcons(wanted = true): IconSet | null {
  const [set, setSet] = useState(loaded);
  useEffect(() => {
    if (!wanted || set !== null) return;
    let current = true;
    loadIcons().then(
      (next) => {
        if (current) setSet(next);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [wanted, set]);
  return set;
}
