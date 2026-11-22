import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from "react";
import { useI18n } from "../i18n/i18n";
import {
  clampWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_SNAP_WIDTH,
} from "./sidebarState";
import "./shellUx.css";

/** Where a drag ends up: the rail below the snap point, hidden at the window's edge. */
type Snap = "rail" | "hide" | null;

/** Dragged closer than this to the window's edge, the sidebar hides completely. */
const SIDEBAR_HIDE_WIDTH = 40;

/** Arrow keys move the edge by this much; with Shift, by four times as much. */
const KEY_STEP = 16;

interface SidebarResizerProps {
  shellRef: RefObject<HTMLElement | null>;
  sidebarRef: RefObject<HTMLElement | null>;
  /** The remembered width, or undefined for the default. */
  width: number | undefined;
  onCommit: (width: number) => void;
  /** Collapses to the rail: a drag past the snap point, a double click, or Enter. */
  onCollapse: () => void;
  /** Hides the sidebar completely (focus mode): a drag all the way to the window's edge. */
  onHide: () => void;
}

/**
 * The sidebar's edge as a handle: drag it to set the column's width (remembered per person),
 * drag it narrow and the sidebar snaps to the rail, double-click it to collapse. A separator
 * for assistive technology, with the arrow keys for the width.
 */
export function SidebarResizer({
  shellRef,
  sidebarRef,
  width,
  onCommit,
  onCollapse,
  onHide,
}: SidebarResizerProps) {
  const { t } = useI18n();
  const drag = useRef<{ snap: Snap; width: number } | null>(null);

  function currentWidth(): number {
    return width ?? sidebarRef.current?.getBoundingClientRect().width ?? SIDEBAR_MIN_WIDTH;
  }

  function preview(next: number | undefined) {
    const shell = shellRef.current;
    if (shell === null) return;
    if (next === undefined) {
      shell.style.removeProperty("--sidebar-width");
    } else {
      shell.style.setProperty("--sidebar-width", `${next}px`);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { snap: null, width: currentWidth() };
    shellRef.current?.setAttribute("data-resizing", "");
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    const sidebar = sidebarRef.current;
    if (state === null || sidebar === null) return;
    const x = event.clientX - sidebar.getBoundingClientRect().left;
    state.snap = x < SIDEBAR_HIDE_WIDTH ? "hide" : x < SIDEBAR_SNAP_WIDTH ? "rail" : null;
    state.width = clampWidth(x);
    if (state.snap === null) {
      shellRef.current?.removeAttribute("data-snap");
    } else {
      shellRef.current?.setAttribute("data-snap", state.snap);
    }
    preview(state.width);
  }

  function onPointerUp() {
    const state = drag.current;
    drag.current = null;
    shellRef.current?.removeAttribute("data-resizing");
    shellRef.current?.removeAttribute("data-snap");
    if (state === null) return;
    if (state.snap !== null) {
      // The column keeps its remembered width for the next time it opens.
      preview(width);
      if (state.snap === "hide") onHide();
      else onCollapse();
    } else {
      onCommit(state.width);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let next: number | undefined;
    if (event.key === "ArrowLeft") next = currentWidth() - step;
    else if (event.key === "ArrowRight") next = currentWidth() + step;
    else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
    else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
    else if (event.key === "Enter") {
      event.preventDefault();
      onCollapse();
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    onCommit(clampWidth(next));
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, adjustable separator has no element of its own
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("nav.resize")}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width ?? SIDEBAR_DEFAULT_WIDTH}
      title={t("nav.resizeHint")}
      className="shell__resizer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onCollapse}
      onKeyDown={onKeyDown}
    />
  );
}
