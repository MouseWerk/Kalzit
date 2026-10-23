import { useSyncExternalStore } from "react";

/**
 * The app's notifications for saved, failed and undo messages. A confirmation replaces the one
 * before it, as each change confirms itself and the last one is what can be undone. Errors have a
 * slot of their own: a later confirmation never hides an error nobody has read yet. The `Toaster`
 * in the app shell shows both; anything may call `showToast`.
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

export interface Toasts {
  confirmation: Toast | null;
  error: Toast | null;
}

/** How long a confirmation stays; paused while the pointer or focus is on it. */
export const TOAST_MS = 8000;
/** Longer when it offers undo, so there is time to reach the button. */
export const UNDO_TOAST_MS = 12_000;

let current: Toasts = { confirmation: null, error: null };
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: Toasts): void {
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

/** Shows a toast in its slot (errors and confirmations apart) and answers its id. */
export function showToast(input: ToastInput): number {
  const id = nextId++;
  const toast = { ...input, id };
  set(input.error === true ? { ...current, error: toast } : { ...current, confirmation: toast });
  return id;
}

export function showErrorToast(message: string): number {
  return showToast({ message, error: true });
}

/** Dismisses the toast with `id` (a timer of an older toast does nothing), or every toast. */
export function dismissToast(id?: number): void {
  const next = {
    confirmation: id === undefined || current.confirmation?.id === id ? null : current.confirmation,
    error: id === undefined || current.error?.id === id ? null : current.error,
  };
  if (next.confirmation !== current.confirmation || next.error !== current.error) {
    set(next);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Toasts {
  return current;
}

export function useToasts(): Toasts {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
