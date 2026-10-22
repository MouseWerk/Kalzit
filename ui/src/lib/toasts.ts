import { useSyncExternalStore } from "react";

/**
 * The app's notifications for saved, failed and undo messages. One toast at a time: the next one
 * replaces it, as each change confirms itself and the last one is what can be undone. The
 * `Toaster` in the app shell shows it; anything may call `showToast`.
 */
export interface Toast {
  /** Changes with every toast, so the region announces a repeated message again. */
  id: number;
  message: string;
  /** Offered as "Undo"; the change it reverts is already saved. */
  undo?: (() => void) | undefined;
  /** An error is announced assertively, drawn with the danger tint and stays until dismissed. */
  error?: boolean | undefined;
}

export type ToastInput = Omit<Toast, "id">;

/** How long a confirmation stays; paused while the pointer or focus is on it. */
export const TOAST_MS = 8000;
/** Longer when it offers undo, so there is time to reach the button. */
export const UNDO_TOAST_MS = 12_000;

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function showToast(input: ToastInput): number {
  const id = nextId++;
  current = { ...input, id };
  emit();
  return id;
}

export function showErrorToast(message: string): number {
  return showToast({ message, error: true });
}

/** Dismisses the toast, or only the one with `id` (a timer of an older toast does nothing). */
export function dismissToast(id?: number): void {
  if (current === null || (id !== undefined && current.id !== id)) {
    return;
  }
  current = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Toast | null {
  return current;
}

export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
