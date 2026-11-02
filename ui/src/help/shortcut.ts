import { useEffect, useEffectEvent } from "react";
import { isComposingKey } from "../lib/ime";
import { isMac, modShortcut } from "../shell/sidebarState";

/**
 * The key that opens and closes a screen's help panel: Ctrl+/ (Cmd+/ on macOS). It works from
 * inside a query editor too, where people are when they need help; "/" alone opens search and
 * "?" the shortcuts, so neither is taken.
 */
export function isHelpPanelShortcut(event: KeyboardEvent): boolean {
  // By the character, not the key: "/" is Shift+7 on German keyboards.
  if (event.key !== "/" || event.altKey || isComposingKey(event)) {
    return false;
  }
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The help panel shortcut as shown and as `aria-keyshortcuts`. */
export function helpPanelShortcut(): { label: string; aria: string } {
  return modShortcut("/");
}

/** Calls `toggle` on the help panel shortcut, anywhere on the page, while mounted. */
export function useHelpPanelShortcut(toggle: () => void): void {
  const onToggle = useEffectEvent(toggle);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isHelpPanelShortcut(event)) {
        event.preventDefault();
        onToggle();
      }
    }
    // Capture: CodeMirror would take Ctrl+/ for comments before it bubbles up.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
