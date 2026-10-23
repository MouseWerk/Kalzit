import { useSyncExternalStore } from "react";

/**
 * Which of the shell's own overlays is open: the command palette or the shortcuts help. A store
 * rather than shell state, so pages (the start page's search button) can open them too.
 */
export type Overlay = "palette" | "shortcuts" | null;

let current: Overlay = null;
const listeners = new Set<() => void>();

export function setOverlay(next: Overlay): void {
  if (next !== current) {
    current = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

export function getOverlay(): Overlay {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOverlay(): Overlay {
  return useSyncExternalStore(subscribe, getOverlay, getOverlay);
}
