import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n/i18n";
import { useEscapeLayer } from "../lib/layers";
import { Swatch } from "./fieldConfig/Legend";
import type { TooltipMode } from "./fieldConfig/legendOptions";
import "./panels.css";
import "./viz.css";

export interface ReadoutRow {
  name: string;
  value: string;
  /** Swatch class (`series-2`, `tone--ok`); none for rows without a color. */
  colorClass?: string;
  /** A free colour for the swatch (`series-free`). */
  freeColor?: string | null;
}

/** One thing in a chart that can be read out: a slice, a bar, a cell, a gauge. */
export interface ReadoutItem {
  label: string;
  rows: readonly ReadoutRow[];
}

export type Hover = (index: number | null, row?: number) => void;

interface ReadoutProps {
  title: string;
  items: readonly ReadoutItem[];
  tooltip: TooltipMode;
  className?: string;
  /** The drawing: it tints the active item and reports which item the pointer is over. */
  children: (active: number | null, hover: Hover) => ReactNode;
}

/**
 * Keyboard access, a live readout and the hover tooltip for charts made of discrete items. The
 * chart is one focusable group: arrow keys step through the items (Home and End jump, Escape
 * clears), and the item is read out in a live region. Hovering shows the same text as a
 * tooltip without making a screen reader chatter. The tooltip setting decides what it shows:
 * every row of the item, the row under the pointer only, or nothing.
 */
export function Readout({ title, items, tooltip, className, children }: ReadoutProps) {
  const { t } = useI18n();
  const hintId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [row, setRow] = useState<number | undefined>(undefined);
  const [byKeyboard, setByKeyboard] = useState(false);
  const [focused, setFocused] = useState(false);

  useEscapeLayer(focused && byKeyboard && active !== null, () => {
    setActive(null);
    setByKeyboard(false);
  });

  const current = active === null ? undefined : items[active];
  const spoken =
    current === undefined || !byKeyboard
      ? ""
      : [current.label, ...current.rows.map((r) => `${r.name}: ${r.value}`)]
          .filter((part) => part !== "")
          .join(", ");
  const rows =
    current === undefined
      ? []
      : tooltip === "single" && row !== undefined && current.rows[row] !== undefined
        ? [current.rows[row] as ReadoutRow]
        : current.rows;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) {
      return;
    }
    const last = items.length - 1;
    const at = active ?? -1;
    const keys: Record<string, number> = {
      ArrowRight: Math.min(at + 1, last),
      ArrowDown: Math.min(at + 1, last),
      ArrowLeft: Math.max(at - 1, 0),
      ArrowUp: Math.max(at - 1, 0),
      Home: 0,
      End: last,
    };
    const next = keys[event.key];
    if (next !== undefined) {
      event.preventDefault();
      // The keyboard tooltip sits in the corner; the pointer's side no longer applies.
      event.currentTarget.dataset.flipX = "false";
      event.currentTarget.dataset.flipY = "false";
      setByKeyboard(true);
      setRow(undefined);
      setActive(next);
    }
  }

  const hover: Hover = (index, hoveredRow) => {
    if (byKeyboard && focused) {
      return;
    }
    setByKeyboard(false);
    setActive(index);
    setRow(hoveredRow);
  };

  // The tooltip follows the pointer through CSS properties on the box, set directly: moving the
  // pointer re-renders nothing, only a change of the item under it does. Past the middle the
  // tooltip opens to the other side, so it is not cut off at the edges (or on a phone).
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget;
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    box.style.setProperty("--hover-x", `${x}px`);
    box.style.setProperty("--hover-y", `${y}px`);
    box.dataset.flipX = String(x > rect.width / 2);
    box.dataset.flipY = String(y > rect.height / 2);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable chart, not a set of form fields
    <div
      className={`readout ${className ?? ""}`}
      ref={boxRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart takes focus for the keyboard readout
      tabIndex={0}
      role="group"
      aria-label={title}
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        setFocused(true);
        if (event.currentTarget.matches(":focus-visible") && items.length > 0) {
          setByKeyboard(true);
          setActive((a) => a ?? 0);
        }
      }}
      onBlur={() => {
        setFocused(false);
        setByKeyboard(false);
        setActive(null);
      }}
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        if (!byKeyboard) {
          setActive(null);
        }
      }}
    >
      <span className="visually-hidden" id={hintId}>
        {t("panels.readout.hint")}
      </span>
      <span className="visually-hidden" role="status">
        {spoken}
      </span>
      {children(active, hover)}
      {current === undefined || tooltip === "hidden" || rows.length === 0 ? null : (
        <div
          className={byKeyboard ? "readout__tooltip readout__tooltip--fixed" : "readout__tooltip"}
          aria-hidden="true"
        >
          {current.label === "" ? null : <div className="ts__tooltip-time">{current.label}</div>}
          {rows.map((r, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
            <div key={index} className="ts__tooltip-row">
              {r.colorClass === undefined ? (
                <span />
              ) : (
                <Swatch className={r.colorClass} freeColor={r.freeColor} />
              )}
              <span className="truncate">{r.name}</span>
              <span className="ts__tooltip-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
