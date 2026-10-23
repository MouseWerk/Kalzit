import type { KeyboardEvent, PointerEvent } from "react";

/** Arrow keys move a split by this many px; with Shift by four times as much. */
export const SPLIT_STEP = 16;

interface SplitterProps {
  /**
   * `vertical` stands between two columns and moves left and right; `horizontal` stands between
   * two rows and moves up and down (the ARIA meaning of a separator's orientation).
   */
  orientation: "vertical" | "horizontal";
  /** Accessible name, such as "Resize the options pane". */
  label: string;
  /** The id of the pane whose size this separator sets. */
  controls: string;
  /** The current size in px, and its bounds. */
  value: number;
  min: number;
  max: number;
  /**
   * The pane grows when the pointer moves towards the end (right or down) for `1`, towards the
   * start for `-1` (a pane on the right grows when the separator moves left).
   */
  direction?: 1 | -1;
  /** A size while the pointer drags, applied without a render; `onChange` follows on release. */
  onPreview: (value: number) => void;
  /** The size to keep, from the keyboard or at the end of a drag. */
  onChange: (value: number) => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(value, min), max));

/**
 * A focusable separator between two panes. The pointer drags it; the arrow keys move it by
 * `SPLIT_STEP` px (Shift: four steps), Home and End jump to the bounds. While dragging only
 * `onPreview` runs, so the layout follows the pointer without a React render per move.
 */
export function Splitter({
  orientation,
  label,
  controls,
  value,
  min,
  max,
  direction = 1,
  onPreview,
  onChange,
}: SplitterProps) {
  const now = clamp(value, min, max);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = SPLIT_STEP * (event.shiftKey ? 4 : 1);
    const towardsEnd = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    const towardsStart = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    let next: number | undefined;
    if (event.key === towardsEnd) next = now + step * direction;
    else if (event.key === towardsStart) next = now - step * direction;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    onChange(clamp(next, min, max));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = orientation === "vertical" ? event.clientX : event.clientY;
    let last = now;
    let frame = 0;
    const onMove = (move: globalThis.PointerEvent) => {
      const at = orientation === "vertical" ? move.clientX : move.clientY;
      last = clamp(now + (at - start) * direction, min, max);
      // One layout per frame, however many pointer events arrive in it.
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          onPreview(last);
        });
      }
    };
    const onUp = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      onPreview(last);
      onChange(last);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, movable separator has no element of its own
    <div
      className={`splitter splitter--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={now}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  );
}
