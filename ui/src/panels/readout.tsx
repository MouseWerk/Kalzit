import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { FloatingTooltip, type FloatingTooltipHandle } from "../components/FloatingTooltip";
import { useI18n } from "../i18n/i18n";
import { useEscapeLayer } from "../lib/layers";
import { POINTER_GAP_PX, type TooltipAnchor, visibleBox } from "../lib/tooltipPlace";
import { shortcutSpoken } from "../shortcuts/registry";
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
 * every row of the item, the row under the pointer only, or nothing. The tooltip lies above the
 * whole page (FloatingTooltip), beside the pointer and inside the viewport, so neither the
 * panel's edge nor a neighbour, a sticky heading or a bar cuts or covers it.
 */
export function Readout({ title, items, tooltip, className, children }: ReadoutProps) {
  const { t } = useI18n();
  const hintId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<FloatingTooltipHandle>(null);
  // Where the pointer is, in the viewport: the tooltip's place while hovering.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
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

  // The tooltip follows the pointer, placed directly: moving the pointer re-renders nothing, only
  // a change of the item under it does.
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    pointerRef.current = { x: event.clientX, y: event.clientY };
    tipRef.current?.place();
  }

  // The keyboard's tooltip sits in the corner of the chart (of what shows of it); the pointer's
  // beside the pointer.
  function tooltipAnchor(): TooltipAnchor | null {
    if (byKeyboard) {
      const shown = boxRef.current === null ? null : visibleBox(boxRef.current);
      return shown === null
        ? null
        : { x: shown.left, y: shown.top, gapX: 0, gapY: 0, within: shown };
    }
    const pointer = pointerRef.current;
    return pointer === null ? null : { ...pointer, gapX: POINTER_GAP_PX, gapY: POINTER_GAP_PX };
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
        {t("panels.readout.hint", {
          ends: shortcutSpoken("chart.ends"),
          close: shortcutSpoken("chart.readoutEnd"),
        })}
      </span>
      <span className="visually-hidden" role="status">
        {spoken}
      </span>
      {children(active, hover)}
      {current === undefined || tooltip === "hidden" || rows.length === 0 ? null : (
        <FloatingTooltip ref={tipRef} className="readout__tooltip" anchor={tooltipAnchor}>
          {current.label === "" ? null : <div className="ts__tooltip-time">{current.label}</div>}
          {rows.map((r, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
            <div key={index} className="ts__tooltip-row">
              {r.colorClass === undefined ? (
                <span />
              ) : (
                <Swatch className={r.colorClass} freeColor={r.freeColor} />
              )}
              <span className="truncate" title={r.name}>
                {r.name}
              </span>
              <span className="ts__tooltip-value">{r.value}</span>
            </div>
          ))}
        </FloatingTooltip>
      )}
    </div>
  );
}
