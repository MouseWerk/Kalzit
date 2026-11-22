import { useSyncExternalStore } from "react";
import { getLanguage } from "../i18n/i18n";
import { readPreference, writePreference } from "../lib/storage";

/** "true" while the sidebar is collapsed to the icon rail; absent or anything else is expanded. */
export const SIDEBAR_STORAGE_KEY = "kalzit.sidebar.collapsed";
/** "true" while focus mode hides the sidebar completely (it peeks in from the window's edge). */
export const SIDEBAR_FOCUS_STORAGE_KEY = "kalzit.sidebar.focus";
/** The column's width in CSS pixels, set by dragging its edge; absent is the default width. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "kalzit.sidebar.width";
/** The column's width range while dragging; a drag below the snap point collapses to the rail. */
export const SIDEBAR_MIN_WIDTH = 192;
export const SIDEBAR_MAX_WIDTH = 384;
export const SIDEBAR_SNAP_WIDTH = 128;
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

export function readFocus(): boolean {
  return readPreference(SIDEBAR_FOCUS_STORAGE_KEY) === "true";
}

export function writeFocus(focus: boolean): void {
  writePreference(SIDEBAR_FOCUS_STORAGE_KEY, String(focus));
}

export function clampWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** The remembered width, or undefined for the default (a token, so it follows the font size). */
export function readWidth(): number | undefined {
  const raw = readPreference(SIDEBAR_WIDTH_STORAGE_KEY);
  // Only a plain number counts: an empty or broken value is the default width, not the minimum.
  return raw !== null && /^\d+(\.\d+)?$/.test(raw.trim()) ? clampWidth(Number(raw)) : undefined;
}

export function writeWidth(width: number): void {
  writePreference(SIDEBAR_WIDTH_STORAGE_KEY, String(clampWidth(width)));
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

/** Key names as printed on the keyboard of the UI's language (docs/glossary.md, Style). */
const GERMAN_KEYS: Record<string, string> = {
  Ctrl: "Strg",
  Shift: "Umschalt",
  Enter: "Eingabe",
  Del: "Entf",
  Home: "Pos1",
  End: "Ende",
  PgUp: "Bild auf",
  PgDn: "Bild ab",
};

/** A key's name in the current language: Strg, Umschalt and Eingabe on German keyboards. */
export function keyLabel(key: string): string {
  return getLanguage() === "de" ? (GERMAN_KEYS[key] ?? key) : key;
}

/** A shortcut with the platform's modifier: Cmd on macOS, else Ctrl in the UI's language. */
export function modShortcut(key: string): { label: string; aria: string } {
  return isMac()
    ? { label: `⌘${key}`, aria: `Meta+${key}` }
    : { label: `${keyLabel("Ctrl")}+${key}`, aria: `Control+${key}` };
}

/** The toggle shortcut as shown in the tooltip and as `aria-keyshortcuts`. */
export function sidebarShortcut(): { label: string; aria: string } {
  return modShortcut("B");
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

/** The focus mode shortcut: Ctrl+Shift+B, or Cmd+Shift+B on macOS. */
export function focusShortcut(): { label: string; aria: string } {
  return isMac()
    ? { label: "⇧⌘B", aria: "Meta+Shift+B" }
    : { label: `${keyLabel("Ctrl")}+${keyLabel("Shift")}+B`, aria: "Control+Shift+B" };
}

/** Whether a key press asks for focus mode: the toggle shortcut with Shift. */
export function isFocusShortcut(event: KeyboardEvent): boolean {
  const isB = event.key.toLowerCase() === "b" || event.code === "KeyB";
  if (!isB || !event.shiftKey || event.altKey || event.isComposing) {
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
      'input, textarea, select, button.select, [contenteditable]:not([contenteditable="false"]), .cm-editor',
    ) !== null
  );
}
