import { SEQUENCE_MS } from "../../../features/dashboards/timeShortcuts";
import type { Direction } from "../drawing";
import { NUDGE_BIG_PX, NUDGE_PX } from "./edits";

/**
 * The keys of a graph's canvas (Graph 0.8.1 board, frame 20) as one pure table, so the whole key
 * matrix is tested without a canvas. The M3 keys keep their meaning (Enter, Space, S, P, Escape,
 * + - 0, arrows); new actions only take free keys; nothing here takes a global shortcut: "/" and
 * "?" are never handled, "E" opens the panel editor, Ctrl+F stays the browser's search, Shift+L
 * is the layout's "Rearrange", and the second key of a "t" sequence (t then ←, →, z, c or v)
 * goes to the time range.
 */

export type CanvasKeyAction =
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "selectAll" }
  | { kind: "invert" }
  | { kind: "menu" }
  | { kind: "nudge"; dx: number; dy: number }
  | { kind: "area"; key: Direction | "enter"; big: boolean }
  | { kind: "walkMove"; by: 1 | -1 }
  | { kind: "walkSelect" }
  | { kind: "move"; direction: Direction }
  | { kind: "activate" }
  | { kind: "toggleSelect" }
  | { kind: "pin" }
  | { kind: "only" }
  | { kind: "hide" }
  | { kind: "showAll" }
  | { kind: "neighbours" }
  | { kind: "walk" }
  | { kind: "tool"; tool: "pointer" | "rect" | "lasso" }
  | { kind: "search" }
  | { kind: "card" }
  | { kind: "minimap" }
  | { kind: "view" }
  | { kind: "zoom"; factor: number }
  | { kind: "fit" };

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What else decides a key: the keyboard rectangle is being drawn, or the walk along edges. */
export interface KeyMode {
  rect: boolean;
  walking: boolean;
}

const DIRECTIONS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** The second keys of the time range shortcuts (timeShortcuts.ts), after "t". */
const TIME_KEYS = new Set(["ArrowLeft", "ArrowRight", "z", "Z", "c", "C", "v", "V"]);

/** The canvas action for a key, or null when the key is not the canvas's to take. */
export function canvasKey(press: KeyPress, mode: KeyMode): CanvasKeyAction | null {
  const key = press.key.toLowerCase();
  const mod = press.ctrlKey || press.metaKey;
  if (mod && !press.altKey && key === "z") return { kind: press.shiftKey ? "redo" : "undo" };
  if (mod && !press.shiftKey && !press.altKey && key === "a") return { kind: "selectAll" };
  if (mod && !press.shiftKey && !press.altKey && key === "i") return { kind: "invert" };
  if ((press.shiftKey && press.key === "F10") || press.key === "ContextMenu") {
    return { kind: "menu" };
  }
  const direction = DIRECTIONS[press.key];
  if (direction !== undefined && press.altKey && !mod) {
    const step = press.shiftKey ? NUDGE_BIG_PX : NUDGE_PX;
    return {
      kind: "nudge",
      dx: direction === "left" ? -step : direction === "right" ? step : 0,
      dy: direction === "up" ? -step : direction === "down" ? step : 0,
    };
  }
  if (mod || press.altKey) return null;
  if (mode.rect && (direction !== undefined || press.key === "Enter")) {
    return { kind: "area", key: direction ?? "enter", big: press.shiftKey };
  }
  if (mode.walking && direction !== undefined) {
    return { kind: "walkMove", by: direction === "left" || direction === "up" ? -1 : 1 };
  }
  if (mode.walking && press.key === " ") return { kind: "walkSelect" };
  if (direction !== undefined) return { kind: "move", direction };
  const plain = !press.shiftKey;
  switch (press.key === " " ? " " : key) {
    case "enter":
      return { kind: "activate" };
    case " ":
      return { kind: "toggleSelect" };
    case "p":
      return { kind: "pin" };
    case "s":
      return { kind: "only" };
    case "h":
      return { kind: press.shiftKey ? "showAll" : "hide" };
    case "n":
      return plain ? { kind: "neighbours" } : null;
    case "k":
      return plain ? { kind: "walk" } : null;
    case "v":
      return plain ? { kind: "tool", tool: "pointer" } : null;
    case "r":
      return plain ? { kind: "tool", tool: "rect" } : null;
    case "l":
      return plain ? { kind: "tool", tool: "lasso" } : null;
    case "f":
      return plain ? { kind: "search" } : null;
    case "i":
      return plain ? { kind: "card" } : null;
    case "m":
      return plain ? { kind: "minimap" } : null;
    case "a":
      return plain ? { kind: "view" } : null;
    case "+":
    case "=":
      return { kind: "zoom", factor: 1.5 };
    case "-":
      return { kind: "zoom", factor: 1 / 1.5 };
    case "0":
      return { kind: "fit" };
    default:
      return null;
  }
}

/**
 * Follows the "t" sequences of the time range: a plain "t" arms it, and the key after it within
 * SEQUENCE_MS is the time range's when it is one of its second keys. `pass` says the canvas
 * leaves the key alone.
 */
export function timeSequence(): (press: KeyPress & { timeStamp: number }) => boolean {
  let armedAt = Number.NEGATIVE_INFINITY;
  return (press) => {
    const plain = !(press.ctrlKey || press.metaKey || press.altKey);
    if (plain && (press.key === "t" || press.key === "T")) {
      armedAt = press.timeStamp;
      return true;
    }
    const armed = press.timeStamp - armedAt <= SEQUENCE_MS;
    armedAt = Number.NEGATIVE_INFINITY;
    return armed && plain && TIME_KEYS.has(press.key);
  };
}

/** The parts of a keyboard event the canvas keys read. */
export function pressOf(event: KeyPress): KeyPress {
  return {
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  };
}
