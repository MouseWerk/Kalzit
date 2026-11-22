import { type RefObject, useEffect, useRef, useState } from "react";

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
  /** Closes after the leaving delay, unless the pointer came back or a menu in it is open. */
  close: (delay?: number) => void;
  /** Ends the closing slide; called from the sidebar's transition end. */
  settle: () => void;
}

function hasOpenMenu(sidebar: HTMLElement | null): boolean {
  return sidebar?.querySelector('[aria-expanded="true"][aria-haspopup]') != null;
}

export function useSidebarPeek(
  enabled: boolean,
  sidebarRef: RefObject<HTMLElement | null>,
  pathname: string,
): SidebarPeek {
  const [state, setState] = useState<PeekState>("closed");
  const timer = useRef<number | undefined>(undefined);
  const fallback = useRef<number | undefined>(undefined);

  function clearTimers() {
    window.clearTimeout(timer.current);
    window.clearTimeout(fallback.current);
  }

  function settle() {
    window.clearTimeout(fallback.current);
    setState((current) => (current === "closing" ? "closed" : current));
  }

  function open(delay = OPEN_DELAY_MS) {
    if (!enabled) return;
    clearTimers();
    if (delay === 0) {
      setState("open");
      return;
    }
    timer.current = window.setTimeout(() => setState("open"), delay);
  }

  function close(delay = CLOSE_DELAY_MS) {
    clearTimers();
    timer.current = window.setTimeout(() => {
      const sidebar = sidebarRef.current;
      // A menu opened from the peek keeps it out until the menu closes.
      if (sidebar?.matches(":hover") || hasOpenMenu(sidebar)) return;
      setState((current) => (current === "open" ? "closing" : current));
      fallback.current = window.setTimeout(settle, CLOSING_FALLBACK_MS);
    }, delay);
  }

  // Following a link from the peek, or the rail turning into the column, ends the peek.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not an input
  useEffect(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(fallback.current);
    setState("closed");
  }, [pathname, enabled]);

  // A click on the page outside the sidebar (and outside its menus, drawn in the window) closes it.
  useEffect(() => {
    if (state !== "open") return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (sidebarRef.current?.contains(target) || target.closest('[role="menu"], .menu') !== null) {
        return;
      }
      window.clearTimeout(timer.current);
      setState("closing");
      window.clearTimeout(fallback.current);
      fallback.current = window.setTimeout(() => setState("closed"), CLOSING_FALLBACK_MS);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [state, sidebarRef]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(fallback.current);
    },
    [],
  );

  return { state: enabled ? state : "closed", open, close, settle };
}
