import { useEffect, useSyncExternalStore } from "react";

/**
 * The name of the page a layout's breadcrumbs end with, when the page itself knows it (a team or
 * a role, loaded on the page). The page publishes it; the breadcrumbs read it.
 */
let current: string | undefined;
const listeners = new Set<() => void>();

function set(next: string | undefined): void {
  if (next !== current) {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): string | undefined {
  return current;
}

/** Publishes the page's name while the page is shown. */
export function usePublishCrumbTitle(title: string | undefined): void {
  useEffect(() => {
    set(title);
    return () => set(undefined);
  }, [title]);
}

export function useCrumbTitle(): string | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
