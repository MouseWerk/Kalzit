import { type RefObject, useEffect, useRef, useState } from "react";
import { openLayerCount } from "../lib/layers";
import { lastInputWasKeyboard } from "./inputModality";

/**
 * The sidebar's peek: while it is the icon rail or hidden by focus mode, resting the pointer on
 * it (or on the window's edge) slides the full sidebar out over the page without moving the
 * page; leaving it slides it back.
 *
 * "open" shows the full sidebar at full width. "closing" keeps the full content while the box
 * slides back, so the labels are clipped away instead of the rail's icons jumping; then it is
 * "closed" and the rail (or nothing) shows again.
 */
export type PeekState = "closed" | "open" | "closing";

/** How long the pointer rests before the sidebar peeks, and before it slides back. */
const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 300;
/** Longer than --duration-sidebar: the fallback when no transition end arrives. */
const CLOSING_FALLBACK_MS = 400;

export interface SidebarPeek {
  state: PeekState;
  /** Opens after the resting delay; `0` opens at once (F6 in focus mode). */
  open: (delay?: number) => void;
  /**
   * Closes after the leaving delay. Without `force` it waits while the pointer is back on it,
   * the keyboard works in it, or a menu or dialog opened from it is open, and checks again
   * once those are gone. Escape and a click on the page force it.
   */
  close: (delay?: number, force?: boolean) => void;
  /** Ends the closing slide; called from the sidebar's own closing animation or transition. */
  settle: () => void;
}

function hasOpenMenu(sidebar: HTMLElement | null): boolean {
  return sidebar?.querySelector('[aria-expanded="true"][aria-haspopup]') != null;
}

/**
 * @param onFocusLeft called when the peek starts closing while the focus is inside it, so the
 *   caller can move the focus somewhere visible (focus mode hides the sidebar completely).
 */
export function useSidebarPeek(
  enabled: boolean,
  sidebarRef: RefObject<HTMLElement | null>,
  pathname: string,
  onFocusLeft: () => void,
): SidebarPeek {
  const [state, setState] = useState<PeekState>("closed");
  const current = useRef<PeekState>("closed");
  const timer = useRef<number | undefined>(undefined);
  const fallback = useRef<number | undefined>(undefined);

  function set(next: PeekState) {
    current.current = next;
    setState(next);
  }

  function clearTimers() {
    window.clearTimeout(timer.current);
    window.clearTimeout(fallback.current);
  }

  function settle() {
    window.clearTimeout(fallback.current);
    if (current.current === "closing") set("closed");
  }

  function startClosing() {
    if (current.current !== "open") return;
    const sidebar = sidebarRef.current;
    if (sidebar?.contains(document.activeElement)) onFocusLeft();
    set("closing");
    window.clearTimeout(fallback.current);
    fallback.current = window.setTimeout(settle, CLOSING_FALLBACK_MS);
  }

  function open(delay = OPEN_DELAY_MS) {
    if (!enabled) return;
    clearTimers();
    // Coming back while it slides away reopens it at once instead of letting it shut first.
    if (delay === 0 || current.current === "closing") {
      set("open");
      return;
    }
    timer.current = window.setTimeout(() => set("open"), delay);
  }

  function close(delay = CLOSE_DELAY_MS, force = false) {
    clearTimers();
    timer.current = window.setTimeout(() => {
      const sidebar = sidebarRef.current;
      if (!force) {
        // The pointer came back: its next leave closes it.
        if (sidebar?.matches(":hover")) return;
        // A menu or dialog opened from it, or the keyboard working in it: look again later, so
        // it closes once they are done instead of staying out for good.
        const keyboardInside = sidebar?.contains(document.activeElement) && lastInputWasKeyboard();
        if (hasOpenMenu(sidebar) || openLayerCount() > 0 || keyboardInside) {
          close(delay);
          return;
        }
      }
      startClosing();
    }, delay);
  }

  // Following a link from the peek, or the rail turning into the column, ends the peek.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(fallback.current);
    current.current = "closed";
    setState("closed");
  }, [pathname, enabled]);

  // A click on the page outside the sidebar (and outside its menus, drawn in the window) closes it.
  useEffect(() => {
    if (state !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        sidebarRef.current?.contains(target) ||
        target.closest('[role="menu"], .menu, [role="dialog"]') !== null
      ) {
        return;
      }
      window.clearTimeout(timer.current);
      startClosing();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  });

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(fallback.current);
    },
    [],
  );

  return { state: enabled ? state : "closed", open, close, settle };
}
