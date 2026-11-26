import { type PointerEvent, type RefObject, useEffect, useRef } from "react";
import { IconButton } from "../../../components/IconButton";
import { useI18n } from "../../../i18n/i18n";
import type { CanvasHandle, Overview } from "../SigmaCanvas";
import { followCanvas } from "./follow";
import "./canvas.css";

/** The minimap's size in CSS px. */
export const MINIMAP_WIDTH = 132;
export const MINIMAP_HEIGHT = 88;
/** Space kept around the drawing inside the minimap, in px. */
const PAD = 6;
/** Below this panel width or height the minimap starts folded (frame 6). */
export const MINIMAP_MIN_WIDTH = 420;
export const MINIMAP_MIN_HEIGHT = 240;

/** How overview coordinates map onto the minimap: x and y scale and offset (y may be flipped). */
export interface MiniFrame {
  scale: number;
  x0: number;
  y0: number;
  /** -1 when the overview's y grows upwards (the renderer's frame), 1 when downwards. */
  flip: 1 | -1;
}

/**
 * Fits the overview (its nodes and the part the canvas shows) into a minimap of `width` x
 * `height` px. Pure, so it is tested without a canvas.
 */
export function miniFrame(overview: Overview, width: number, height: number): MiniFrame {
  let x0 = Math.min(overview.view.from[0], overview.view.to[0]);
  let x1 = Math.max(overview.view.from[0], overview.view.to[0]);
  let y0 = Math.min(overview.view.from[1], overview.view.to[1]);
  let y1 = Math.max(overview.view.from[1], overview.view.to[1]);
  for (let i = 0; i + 1 < overview.points.length; i += 2) {
    const x = overview.points[i] as number;
    const y = overview.points[i + 1] as number;
    if (!(Number.isFinite(x) && Number.isFinite(y))) continue;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const spanX = x1 - x0 || 1;
  const spanY = y1 - y0 || 1;
  const scale = Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY);
  // The top of the canvas has the larger y where the frame's y grows upwards.
  const flip = overview.view.from[1] > overview.view.to[1] ? -1 : 1;
  return {
    scale,
    x0: (width - spanX * scale) / 2 - x0 * scale,
    y0:
      flip === 1
        ? (height - spanY * scale) / 2 - y0 * scale
        : (height + spanY * scale) / 2 + y0 * scale,
    flip,
  };
}

/** An overview point on the minimap, in px. */
export function toMini(frame: MiniFrame, x: number, y: number): [number, number] {
  return [frame.x0 + x * frame.scale, frame.y0 + frame.flip * y * frame.scale];
}

/** A minimap point (px) in overview coordinates. */
export function fromMini(frame: MiniFrame, px: number, py: number): [number, number] {
  return [(px - frame.x0) / frame.scale, (py - frame.y0) / (frame.flip * frame.scale)];
}

/**
 * The minimap, bottom right on the canvas (Graph 0.8.1 board, frame 6): every visible node as a
 * quiet dot and the part the canvas shows as a barely tinted neutral area with a thin neutral
 * line. A click jumps there, dragging moves the visible part; M folds it. For screen readers it
 * is decoration: the status line says how much is visible.
 */
export function Minimap({
  canvas,
  ready,
  open,
  onToggle,
}: {
  canvas: RefObject<CanvasHandle | null>;
  /** Whether the canvas is there (it loads lazily); the minimap follows it from then on. */
  ready: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = useRef<MiniFrame | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const handle = canvas.current;
    const element = ref.current;
    if (!open || !ready || handle === null || element === null) return;
    const context = element.getContext("2d");
    if (context === null) return;
    // The element's own text color: neutral, and the system's text color in forced colors. Read
    // once per showing, not per frame; a theme change remounts the panel's probes and redraws.
    const color = getComputedStyle(element).color;
    const draw = () => {
      const overview = handle.overview();
      if (overview === null) return;
      const ratio = window.devicePixelRatio || 1;
      if (element.width !== Math.round(MINIMAP_WIDTH * ratio)) {
        element.width = Math.round(MINIMAP_WIDTH * ratio);
        element.height = Math.round(MINIMAP_HEIGHT * ratio);
      }
      const fit = miniFrame(overview, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      frame.current = fit;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);
      context.fillStyle = color;
      context.globalAlpha = 0.7;
      const points = overview.points;
      const yScale = fit.flip * fit.scale;
      for (let i = 0; i + 1 < points.length; i += 2) {
        const x = fit.x0 + (points[i] as number) * fit.scale;
        const y = fit.y0 + (points[i + 1] as number) * yScale;
        context.fillRect(x - 1, y - 1, 2, 2);
      }
      const [ax, ay] = toMini(fit, overview.view.from[0], overview.view.from[1]);
      const [bx, by] = toMini(fit, overview.view.to[0], overview.view.to[1]);
      const left = Math.max(0.5, Math.min(ax, bx));
      const top = Math.max(0.5, Math.min(ay, by));
      const right = Math.min(MINIMAP_WIDTH - 0.5, Math.max(ax, bx));
      const bottom = Math.min(MINIMAP_HEIGHT - 0.5, Math.max(ay, by));
      context.globalAlpha = 0.08;
      context.fillRect(left, top, right - left, bottom - top);
      context.globalAlpha = 1;
      context.lineWidth = 1;
      context.strokeStyle = color;
      context.strokeRect(left, top, right - left, bottom - top);
    };
    return followCanvas(handle, draw);
  }, [open, ready, canvas]);

  function pan(event: PointerEvent<HTMLCanvasElement>) {
    const fit = frame.current;
    if (fit === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    const [x, y] = fromMini(fit, event.clientX - box.left, event.clientY - box.top);
    canvas.current?.panTo(x, y);
  }

  return (
    <div className="graph-minimap" data-open={open ? "" : undefined}>
      {open ? (
        <canvas
          ref={ref}
          className="graph-minimap__canvas"
          width={MINIMAP_WIDTH}
          height={MINIMAP_HEIGHT}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            pan(event);
          }}
          onPointerMove={(event) => {
            if (dragging.current) pan(event);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        />
      ) : null}
      <IconButton
        className="graph-minimap__toggle"
        icon={open ? "chevronDown" : "chevronUp"}
        label={open ? t("graphCanvas.minimap.hide") : t("graphCanvas.minimap.show")}
        shortcut="graph.minimap"
        aria-expanded={open}
        onClick={onToggle}
      />
    </div>
  );
}
