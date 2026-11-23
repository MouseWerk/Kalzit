import { useEffect, useEffectEvent } from "react";
import { openLayerCount } from "../../lib/layers";
import { isTypingTarget } from "../../shell/sidebarState";
import { matchesSequenceStep, type ShortcutId } from "../../shortcuts/registry";

/** How long after `t` the second key still counts. */
export const SEQUENCE_MS = 1500;

export type TimeShortcut = "back" | "forward" | "zoomOut" | "copy" | "paste";

/** The registry's sequences and what each one does; the keys are defined there. */
const SEQUENCES: readonly (readonly [ShortcutId, TimeShortcut])[] = [
  ["time.back", "back"],
  ["time.forward", "forward"],
  ["time.zoomOut", "zoomOut"],
  ["time.copy", "copy"],
  ["time.paste", "paste"],
];

/**
 * The time range shortcuts: `t` and then Left or Right moves the range, `t z` zooms out, `t c`
 * copies the range and `t v` pastes one. Never while typing, with a modifier, or while a menu
 * or dialog is open.
 */
export function useTimeShortcuts(enabled: boolean, run: (shortcut: TimeShortcut) => void): void {
  const onShortcut = useEffectEvent(run);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let armedAt = Number.NEGATIVE_INFINITY;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        isTypingTarget(event.target) ||
        openLayerCount() > 0
      ) {
        armedAt = Number.NEGATIVE_INFINITY;
        return;
      }
      const shortcut = SEQUENCES.find(([id]) => matchesSequenceStep(id, 1, event))?.[1];
      if (shortcut !== undefined && event.timeStamp - armedAt <= SEQUENCE_MS) {
        armedAt = Number.NEGATIVE_INFINITY;
        event.preventDefault();
        onShortcut(shortcut);
        return;
      }
      armedAt = SEQUENCES.some(([id]) => matchesSequenceStep(id, 0, event))
        ? event.timeStamp
        : Number.NEGATIVE_INFINITY;
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
