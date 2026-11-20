import {
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import {
  placeTooltip,
  type Size,
  type TooltipAnchor,
  tooltipRoom,
  viewportSize,
} from "../lib/tooltipPlace";
import "./floatingTooltip.css";

export interface FloatingTooltipHandle {
  /** Places the tooltip again, after the point it belongs to has moved. */
  place: () => void;
}

interface FloatingTooltipProps {
  ref?: Ref<FloatingTooltipHandle>;
  /** The tooltip's look; its place and layer come from here. */
  className: string;
  /** What the tooltip belongs to right now; `null` hides it. */
  anchor: () => TooltipAnchor | null;
  children: ReactNode;
}

/** One tooltip on the page and what is known about it between placements. */
interface Entry {
  tip: HTMLElement | null;
  anchor: () => TooltipAnchor | null;
  /** Its size as last measured; `null` until measured and after anything that may change it. */
  size: Size | null;
  /** The width it is held to (the chart it has to stay in), as last written. */
  room: number | null;
  /** The place last written, so the same place is not written twice. */
  placed: string;
}

/**
 * Tooltips are placed together, once after everything that asked for it in the same turn: a
 * shared cursor moves the tooltips of every time panel of a dashboard at once, and measuring
 * and moving them one by one would lay the page out once per tooltip. All reads come before all
 * writes: the anchors, then the widths that changed, then the sizes that are not known, then the
 * places. A microtask, not a frame: the place is there before the browser paints.
 */
const waiting = new Set<Entry>();
let scheduled = false;

function request(entry: Entry) {
  waiting.add(entry);
  if (!scheduled) {
    scheduled = true;
    queueMicrotask(placeAll);
  }
}

function placeAll() {
  scheduled = false;
  const entries = [...waiting].filter((entry) => entry.tip?.isConnected === true);
  waiting.clear();
  if (entries.length === 0) {
    return;
  }
  const viewport = viewportSize();
  const anchors = entries.map((entry) => entry.anchor());
  entries.forEach((entry, index) => {
    const room = tooltipRoom(anchors[index] ?? null);
    if (room !== entry.room && entry.tip !== null) {
      // Through the CSSOM: the content security policy refuses style attributes, not script.
      if (room === null) {
        entry.tip.style.removeProperty("--tooltip-room");
      } else {
        entry.tip.style.setProperty("--tooltip-room", `${room}px`);
      }
      entry.room = room;
      entry.size = null;
    }
  });
  entries.forEach((entry, index) => {
    if (entry.size === null && anchors[index] !== null && entry.tip !== null) {
      const { width, height } = entry.tip.getBoundingClientRect();
      entry.size = { width, height };
    }
  });
  entries.forEach((entry, index) => {
    const { tip, size } = entry;
    const anchor = anchors[index] ?? null;
    if (tip === null) {
      return;
    }
    const place = anchor === null || size === null ? null : placeTooltip(anchor, size, viewport);
    if (place === null) {
      // Nothing to belong to, or no room where it has to stay: not shown.
      if (entry.placed !== "") {
        delete tip.dataset.placed;
        entry.placed = "";
      }
      return;
    }
    const left = Math.round(place.left);
    const top = Math.round(place.top);
    const placed = `${left},${top}`;
    if (placed !== entry.placed) {
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.dataset.placed = "";
      entry.placed = placed;
    }
  });
}

/**
 * The browser reports a tooltip's size when it changes (new values, a font that arrived), so no
 * placement has to measure it. Where it cannot (tests without layout), every render measures.
 *
 * A tooltip is observed from the next frame on, never during the effect that mounts it. The
 * page's ResizeObservers deliver, after a first round, only elements deeper than the shallowest
 * element any of them reported in that round; a tooltip lies right in the body, above nearly
 * everything. A tooltip mounted while another observer's callback runs (a panel taking its new
 * size in flushSync, which also flushes waiting effects) would be observed in the middle of that
 * delivery, and its first report could not be delivered any more: "ResizeObserver loop completed
 * with undelivered notifications". Until its first report, a placement measures it.
 */
const entryOf = new WeakMap<Element, Entry>();
const sizes =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((changes) => {
        for (const change of changes) {
          const entry = entryOf.get(change.target);
          const box = change.borderBoxSize?.[0];
          if (entry === undefined || box === undefined) {
            continue;
          }
          const size = { width: box.inlineSize, height: box.blockSize };
          if (entry.size?.width !== size.width || entry.size?.height !== size.height) {
            entry.size = size;
            request(entry);
          }
        }
      });

/**
 * A hover tooltip that lies above everything: rendered at the end of the body and fixed, on the
 * tooltip layer, so the panel it belongs to (or a neighbour, a sticky heading, a bar) can neither
 * clip nor cover it. It is placed from `anchor` after every render, when the owner calls `place`
 * (the pointer moved, which renders nothing) and when the page scrolls or the window changes
 * size. Screen readers get the same text from the owner (its live region or the control's name),
 * so the tooltip is hidden from them.
 */
export function FloatingTooltip({ ref, className, anchor, children }: FloatingTooltipProps) {
  const tipRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<Entry>({ tip: null, anchor, size: null, room: null, placed: "" });

  useLayoutEffect(() => {
    const entry = entryRef.current;
    entry.tip = tipRef.current;
    entry.anchor = anchor;
    if (sizes === null) {
      entry.size = null;
    }
    request(entry);
  });

  useImperativeHandle(ref, () => ({ place: () => request(entryRef.current) }), []);

  useEffect(() => {
    const entry = entryRef.current;
    const tip = tipRef.current;
    const place = () => request(entry);
    let frame: number | null = null;
    if (tip !== null && sizes !== null) {
      entryOf.set(tip, entry);
      frame = requestAnimationFrame(() => {
        frame = null;
        sizes.observe(tip);
      });
    }
    // Capture: scroll events do not bubble, and dashboards scroll inside the page.
    document.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      if (tip !== null) {
        sizes?.unobserve(tip);
      }
      waiting.delete(entry);
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
