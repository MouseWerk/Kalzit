import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { openLayerCount } from "../../lib/layers";
import { isTypingTarget } from "../../shell/sidebarState";
import { isMac } from "../../shortcuts/platform";
import { matchesShortcut, type ShortcutId } from "../../shortcuts/registry";
import type { LinkedAnalysis, LinkedPanel } from "./api";
import type { PanelModel } from "./model";

/** What the panel shortcuts in edit mode do: E, Ctrl+D, Ctrl+C, Ctrl+V and Delete. */
export type PanelShortcut = "edit" | "duplicate" | "copy" | "paste" | "remove";

/** The registry's shortcut for each (shortcuts/builtins.ts, area "dashboardEdit"). */
const PANEL_SHORTCUTS: Record<PanelShortcut, ShortcutId> = {
  edit: "panel.edit",
  duplicate: "panel.duplicate",
  copy: "panel.copy",
  paste: "panel.paste",
  remove: "panel.remove",
};

/** Widgets with keys of their own: a shortcut pressed inside them stays theirs. */
const OWN_KEYS =
  '[role="application"], [role="grid"], [role="tree"], [role="treegrid"], [role="menu"], ' +
  '[role="listbox"], [role="slider"], [role="tablist"]';

/**
 * The panel shortcut a key press asks for, or null. Never while typing (fields, query editors),
 * inside a widget with keys of its own, under an open menu or dialog, or with Alt. Ctrl stands
 * for Cmd on macOS, where Backspace deletes as well (its keyboards have no Delete key).
 */
export function panelShortcutOf(event: KeyboardEvent, mac = isMac()): PanelShortcut | null {
  if (event.defaultPrevented || event.altKey || event.isComposing || openLayerCount() > 0) {
    return null;
  }
  const target = event.target;
  if (isTypingTarget(target) || (target instanceof Element && target.closest(OWN_KEYS) !== null)) {
    return null;
  }
  const platform = mac ? "mac" : "other";
  return (
    (Object.keys(PANEL_SHORTCUTS) as PanelShortcut[]).find((shortcut) =>
      matchesShortcut(PANEL_SHORTCUTS[shortcut], event, platform),
    ) ?? null
  );
}

/**
 * Runs the panel shortcuts while `enabled` (edit mode, nothing else open). `run` gets the
 * shortcut and the panel it is for: the one whose card holds focus, else none (the caller then
 * takes the selected panel). Copying gives way to text selected on the page.
 */
export function usePanelShortcuts(
  enabled: boolean,
  run: (shortcut: PanelShortcut, focusedId: string | null) => boolean,
): void {
  const onShortcut = useEffectEvent(run);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      const shortcut = panelShortcutOf(event);
      if (shortcut === null) {
        return;
      }
      if (shortcut === "copy" && (window.getSelection()?.toString() ?? "") !== "") {
        return;
      }
      const card = event.target instanceof Element ? event.target.closest("[data-panel-id]") : null;
      if (onShortcut(shortcut, card?.getAttribute("data-panel-id") ?? null)) {
        event.preventDefault();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** A copied panel, with the library panel or saved analysis it shows, to paste anywhere. */
export interface CopiedPanel {
  /** The organization it was copied in; it pastes only there (sources and links are per org). */
  orgId: string;
  panel: PanelModel;
  library?: LinkedPanel | undefined;
  analysis?: LinkedAnalysis | undefined;
}

// For this page view only: what was copied stays in memory, never in the browser's storage.
let copied: CopiedPanel | null = null;
const listeners = new Set<() => void>();

export function copyPanel(entry: CopiedPanel): void {
  copied = { ...entry, panel: structuredClone(entry.panel) };
  for (const listener of listeners) listener();
}

function current(): CopiedPanel | null {
  return copied;
}

/** The copied panel, when it was copied in this organization. */
export function copiedPanel(orgId: string): CopiedPanel | null {
  return copied?.orgId === orgId ? copied : null;
}

/** The copied panel of this organization, re-rendering when another is copied. */
export function useCopiedPanel(orgId: string): CopiedPanel | null {
  const entry = useSyncExternalStore((onChange) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, current);
  return entry?.orgId === orgId ? entry : null;
}

/** Forgets the copied panel (tests). */
export function clearCopiedPanel(): void {
  copied = null;
  for (const listener of listeners) listener();
}
