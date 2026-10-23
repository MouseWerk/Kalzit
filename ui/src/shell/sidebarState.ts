import { useSyncExternalStore } from "react";
import { readPreference, writePreference } from "../lib/storage";

/** "true" while the sidebar is collapsed to the icon rail; absent or anything else is expanded. */
export const SIDEBAR_STORAGE_KEY = "kalzit.sidebar.collapsed";
/** JSON object of navigation entry path to true (expanded) or false (collapsed by the user). */
export const NAV_GROUPS_STORAGE_KEY = "kalzit.sidebar.groups";

/** Above this width the sidebar is a column that can collapse; below it, a bar on top. */
export const WIDE_QUERY = "(width > 48rem)";

export function readCollapsed(): boolean {
  return readPreference(SIDEBAR_STORAGE_KEY) === "true";
}

export function writeCollapsed(collapsed: boolean): void {
  writePreference(SIDEBAR_STORAGE_KEY, String(collapsed));
}

function readGroups(): Record<string, boolean> {
  const raw = readPreference(NAV_GROUPS_STORAGE_KEY);
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

/** The remembered expand state of one entry, or undefined when the user never toggled it. */
export function readGroupExpanded(to: string): boolean | undefined {
  const value = readGroups()[to];
  return typeof value === "boolean" ? value : undefined;
}

export function writeGroupExpanded(to: string, expanded: boolean): void {
  writePreference(NAV_GROUPS_STORAGE_KEY, JSON.stringify({ ...readGroups(), [to]: expanded }));
}

function subscribeWide(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function isWide(): boolean {
  // Without matchMedia (tests, very old engines) the column layout is assumed.
  return typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches;
}

/** True while the sidebar is a column (and so can collapse to the rail). */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribeWide, isWide);
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(window.navigator.platform);
}

/** The toggle shortcut as shown in the tooltip and as `aria-keyshortcuts`. */
export function sidebarShortcut(): { label: string; aria: string } {
  return isMac() ? { label: "⌘B", aria: "Meta+B" } : { label: "Ctrl+B", aria: "Control+B" };
}

/**
 * Whether a key press asks to toggle the sidebar: Ctrl+B, or Cmd+B on macOS. The physical key
 * counts too, so the shortcut works on layouts without a Latin B (Cyrillic, Greek).
 */
export function isToggleShortcut(event: KeyboardEvent): boolean {
  const isB = event.key.toLowerCase() === "b" || event.code === "KeyB";
  if (!isB || event.altKey || event.shiftKey || event.isComposing) {
    return false;
  }
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * Whether the key press goes to something the user types into, where Ctrl+B means bold, or to a
 * code editor (also a read-only one), which has its own key bindings.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  return (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor',
    ) !== null
  );
}
