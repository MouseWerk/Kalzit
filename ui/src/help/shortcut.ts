import { useEffect, useEffectEvent } from "react";
import { matchesShortcut } from "../shortcuts/registry";

/**
 * The keys that open and close a screen's help panel: Shift+F1 anywhere, and Ctrl+/ (Cmd+/ on
 * macOS) outside a code editor, where the same keys comment lines out and stay the editor's.
 * "/" alone opens search and "?" the shortcuts, so neither is taken.
 */
export function isHelpPanelShortcut(event: KeyboardEvent): boolean {
  if (!matchesShortcut("explore.helpPanel", event)) {
    return false;
  }
  // By the character, not the key: "/" is Shift+7 on German keyboards.
  return event.key !== "/" || !inCodeEditor(event.target);
}

/** Whether the key press comes from a query editor (CodeMirror, or the plain text area). */
function inCodeEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".cm-editor, .code-editor") !== null;
}

/** Calls `toggle` on the help panel shortcut, anywhere on the page, while mounted. */
export function useHelpPanelShortcut(toggle: () => void): void {
  const onToggle = useEffectEvent(toggle);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.defaultPrevented && !event.repeat && isHelpPanelShortcut(event)) {
        event.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
