import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { isComposingKey } from "../lib/ime";

/** Whether the control right inside `anchor` shows something it opened (a menu, a pane). */
function hasOpened(anchor: Element): boolean {
  return anchor.querySelector(':scope > [aria-expanded="true"]') !== null;
}

/**
 * When a control's tooltip shows: while a mouse or pen is over the control (a finger has no
 * hover) or the control right inside has keyboard focus. Not while the control shows something
 * it opened, which the tooltip would cover; not after Escape (WCAG 1.4.13), until the pointer or
 * the focus has left; and not after a press, until the pointer has left: what the press opened
 * is what the person looks at now.
 */
export function useTip() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [opened, setOpened] = useState(false);
  const active = hovered || focused;
  const shown = active && !dismissed && !pressed && !opened;

  // The control opens and closes its menu while the pointer rests on it.
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!active || anchor === null) {
      return;
    }
    const observer = new MutationObserver(() => setOpened(hasOpened(anchor)));
    observer.observe(anchor, {
      attributes: true,
      attributeFilter: ["aria-expanded"],
      subtree: true,
    });
    return () => observer.disconnect();
  }, [active]);

  const handlers = {
    onPointerEnter(event: PointerEvent<HTMLSpanElement>) {
      if (event.pointerType === "touch") {
        return;
      }
      setOpened(hasOpened(event.currentTarget));
      setHovered(true);
    },
    onPointerLeave() {
      setHovered(false);
      setDismissed(false);
      setPressed(false);
    },
    onPointerDown() {
      setPressed(true);
    },
    onFocus(event: FocusEvent<HTMLSpanElement>) {
      const control = event.target;
      setOpened(hasOpened(event.currentTarget));
      setFocused(
        control.parentElement === event.currentTarget && control.matches(":focus-visible"),
      );
    },
    onBlur() {
      setFocused(false);
      setDismissed(false);
    },
    // No preventDefault: the control inside takes the keys, Escape only hides the tooltip too.
    onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
      if (event.key === "Escape" && shown && !isComposingKey(event)) {
        setDismissed(true);
      }
    },
  };

  return { anchorRef, shown, handlers };
}
