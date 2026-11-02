import { useEffect, useEffectEvent } from "react";
import { isComposingKey } from "../lib/ime";
import { isMac, keyLabel, modShortcut } from "../shell/sidebarState";

/**
 * The keys that open and close a screen's help panel: Shift+F1 anywhere, and Ctrl+/ (Cmd+/ on
 * macOS) outside a code editor, where the same keys comment lines out and stay the editor's.
 * "/" alone opens search and "?" the shortcuts, so neither is taken.
 */
export function isHelpPanelShortcut(event: KeyboardEvent): boolean {
  if (isComposingKey(event) || event.altKey) {
    return false;
  }
  if (event.key === "F1" && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return true;
  }
  // By the character, not the key: "/" is Shift+7 on German keyboards.
  if (event.key !== "/" || inCodeEditor(event.target)) {
    return false;
  }
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether the key press comes from a query editor (CodeMirror, or the plain text area). */
function inCodeEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".cm-editor, .code-editor") !== null;
}

/** The help panel shortcuts as shown and as `aria-keyshortcuts`. */
export function helpPanelShortcut(): { label: string; aria: string } {
  const mod = modShortcut("/");
  return {
    label: `${mod.label}, ${keyLabel("Shift")}+F1`,
    aria: `${mod.aria} Shift+F1`,
  };
}

/** Calls `toggle` on the help panel shortcut, anywhere on the page, while mounted. */
export function useHelpPanelShortcut(toggle: () => void): void {
  const onToggle = useEffectEvent(toggle);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.defaultPrevented && isHelpPanelShortcut(event)) {
        event.preventDefault();
        onToggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
