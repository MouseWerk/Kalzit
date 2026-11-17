import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { placeTooltip, type TooltipAnchor, viewportSize } from "../lib/tooltipPlace";
import "./floatingTooltip.css";

export interface FloatingTooltipHandle {
  /** Places the tooltip again, after the point it belongs to has moved. */
  place: () => void;
}

interface FloatingTooltipProps {
  ref?: Ref<FloatingTooltipHandle>;
  /** The tooltip's look; its place and layer come from here. */
  className: string;
  /** The point the tooltip belongs to right now; `null` hides it. */
  anchor: () => TooltipAnchor | null;
  children: ReactNode;
}

/** Puts `tip` beside `anchor`, inside the viewport; without an anchor it is not shown. */
function put(tip: HTMLElement | null, anchor: TooltipAnchor | null) {
  if (tip === null) {
    return;
  }
  if (anchor === null) {
    delete tip.dataset.placed;
    return;
  }
  const { width, height } = tip.getBoundingClientRect();
  const { left, top } = placeTooltip(anchor, { width, height }, viewportSize());
  // Through the CSSOM: the content security policy refuses style attributes, not script.
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.dataset.placed = "";
}

/**
 * A hover tooltip that lies above everything: rendered at the end of the body and fixed, on the
 * tooltip layer, so the panel it belongs to (or a neighbour, a sticky heading, a bar) can neither
 * clip nor cover it. It is placed from `anchor` after every render (its content, and with it its
 * size, may have changed), when the owner calls `place` (the pointer moved, which renders
 * nothing) and when the page scrolls or the window changes size. Screen readers get the same
 * text from the owner's live region, so the tooltip is hidden from them.
 */
export function FloatingTooltip({ ref, className, anchor, children }: FloatingTooltipProps) {
  const tipRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);

  useLayoutEffect(() => {
    anchorRef.current = anchor;
    put(tipRef.current, anchor());
  });

  useImperativeHandle(ref, () => ({ place: () => put(tipRef.current, anchorRef.current()) }), []);

  useEffect(() => {
    const place = () => put(tipRef.current, anchorRef.current());
    // Capture: scroll events do not bubble, and dashboards scroll inside the page.
    document.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
    };
  }, []);

  return createPortal(
    <div ref={tipRef} className={`floating-tooltip ${className}`} aria-hidden="true">
      {children}
    </div>,
    document.body,
  );
}
