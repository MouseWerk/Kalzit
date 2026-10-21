import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { lastInputWasKeyboard } from "./inputModality";

const GAP_PX = 6;

/**
 * The rail shows only icons. A pointer gets the native `title` tooltip; keyboard focus gets this
 * one, next to the focused control, with the same text. Screen readers already hear the
 * control's name, so it is hidden from them. Entries with sub-pages open their flyout instead.
 */
export function RailTooltip({
  rail,
  sidebarRef,
}: {
  rail: boolean;
  sidebarRef: RefObject<HTMLElement | null>;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const shown = rail ? target : null;

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!rail || sidebar === null) {
      return;
    }
    function onFocusIn(event: FocusEvent) {
      const element = event.target;
      if (
        element instanceof HTMLElement &&
        element.title !== "" &&
        element.closest(".nav-group") === null &&
        lastInputWasKeyboard()
      ) {
        setTarget(element);
      } else {
        setTarget(null);
      }
    }
    function onFocusOut() {
      setTarget(null);
    }
    sidebar.addEventListener("focusin", onFocusIn);
    sidebar.addEventListener("focusout", onFocusOut);
    return () => {
      sidebar.removeEventListener("focusin", onFocusIn);
      sidebar.removeEventListener("focusout", onFocusOut);
      setTarget(null);
    };
  }, [rail, sidebarRef]);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    const sidebar = sidebarRef.current;
    if (shown === null || tip === null || sidebar === null) {
      return;
    }
    const rect = shown.getBoundingClientRect();
    const height = tip.getBoundingClientRect().height;
    tip.style.top = `${rect.top + rect.height / 2 - height / 2}px`;
    tip.style.left = `${sidebar.getBoundingClientRect().right + GAP_PX}px`;
  }, [shown, sidebarRef]);

  if (shown === null) {
    return null;
  }
  return (
    <div ref={tipRef} className="rail-tooltip" aria-hidden="true">
      {shown.title}
    </div>
  );
}
