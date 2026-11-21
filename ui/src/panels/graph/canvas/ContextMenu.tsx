import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../../../components/Icon";
import { useEscapeLayer } from "../../../lib/layers";
import "../../../components/iconButton.css";
import "../graph.css";
import "./canvas.css";

/** One entry of a canvas menu. */
export type CanvasMenuEntry =
  | {
      kind?: "action";
      key: string;
      label: string;
      icon?: IconName | undefined;
      /** Shown at the end of the entry: "H", "Ctrl+I". */
      shortcut?: string | undefined;
      /** Why the entry can do nothing right now; it stays in the menu, greyed, with this title. */
      unavailable?: string | undefined;
      /** A switch that is on. */
      checked?: boolean | undefined;
      onSelect: () => void;
    }
  | { kind: "separator"; key: string };

/** An open canvas menu: what it is for (a view index; -1 for the canvas) and where it opens. */
export interface CanvasMenu {
  kind: "node" | "edge" | "selection" | "canvas";
  index: number;
  at: { x: number; y: number };
}

/** The gap kept between the menu and the window's edge, in px. */
const EDGE_PX = 8;

/** Where a menu of `size` opens for a click at `at`, kept inside a window of `view`. */
export function menuPlace(
  at: { x: number; y: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const left = at.x + size.width + EDGE_PX <= view.width ? at.x : at.x - size.width;
  const top = at.y + size.height + EDGE_PX <= view.height ? at.y : at.y - size.height;
  return {
    left: Math.max(EDGE_PX, Math.min(left, view.width - size.width - EDGE_PX)),
    top: Math.max(EDGE_PX, Math.min(top, view.height - size.height - EDGE_PX)),
  };
}

/**
 * A context menu of the canvas (Graph 0.8.1 board, frame 3): for a node, an edge, the selection
 * or the empty canvas. It opens at the pointer (or at the focused element for Shift+F10 and the
 * menu key), drawn in the window so the panel never clips it. The first entry has the focus;
 * arrow keys, Home and End move, Escape, Tab and a click elsewhere close. An entry that cannot
 * act right now stays, greyed, with the reason as its title.
 */
export function ContextMenu({
  title,
  at,
  entries,
  onClose,
  host,
}: {
  /** What the menu is for: "Anna Weber · Customer". Its accessible name and first line. */
  title: string;
  /** Where it opens, in CSS px from the viewport's top left. */
  at: { x: number; y: number };
  entries: readonly CanvasMenuEntry[];
  /** `refocus`: whether the focus goes back to the canvas (not after a click elsewhere). */
  onClose: (refocus: boolean) => void;
  /** Where the menu is drawn: the page's main landmark, else the body. */
  host: Element | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, () => onClose(true));

  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu === null) return;
    const { width, height } = menu.getBoundingClientRect();
    const view = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
    const place = menuPlace(at, { width, height }, view);
    // Through the CSSOM: the content security policy refuses style attributes, not script.
    menu.style.setProperty("--menu-left", `${place.left}px`);
    menu.style.setProperty("--menu-top", `${place.top}px`);
    menu.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [at]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target) !== true) {
        onClose(false);
      }
    };
    const away = () => onClose(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", away);
    };
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else if (event.key === "Tab") {
      event.preventDefault();
      onClose(true);
      return;
    } else return;
    event.preventDefault();
    // The canvas under the menu does not take its keys.
    event.stopPropagation();
    next?.focus();
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title}
      className="menu toolbar-menu__list graph-menu"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="menu__label" role="presentation">
        {title}
      </div>
      {entries.map((entry) => {
        if (entry.kind === "separator") {
          return <hr key={entry.key} className="toolbar-menu__separator" />;
        }
        const off = entry.unavailable !== undefined;
        return (
          <button
            key={entry.key}
            type="button"
            // A switch is a check box item with its state; any other entry a plain item.
            {...(entry.checked === undefined
              ? { role: "menuitem" }
              : { role: "menuitemcheckbox", "aria-checked": entry.checked })}
            className="menu__item"
            // aria-disabled, not disabled: the entry stays in the arrow-key order, so its name
            // and why it is unavailable are still announced.
            aria-disabled={off ? true : undefined}
            title={entry.unavailable}
            onClick={() => {
              if (off) return;
              onClose(true);
              entry.onSelect();
            }}
          >
            {entry.checked === true ? (
              <Icon name="check" />
            ) : entry.icon === undefined ? (
              <span className="toolbar-menu__check" aria-hidden="true" />
            ) : (
              <Icon name={entry.icon} />
            )}
            <span className="toolbar-menu__label">{entry.label}</span>
            {entry.shortcut === undefined ? null : (
              <kbd className="kbd toolbar-menu__key">{entry.shortcut}</kbd>
            )}
          </button>
        );
      })}
    </div>,
    host ?? document.body,
  );
}
