import { SEQUENCE_MS, TIME_SEQUENCES } from "../../../features/dashboards/timeShortcuts";
import { isComposingKey } from "../../../lib/ime";
import type { Platform } from "../../../shortcuts/keyNames";
import {
  currentPlatform,
  matchesSequenceStep,
  matchesShortcut,
  type ShortcutId,
} from "../../../shortcuts/registry";
import type { Direction } from "../drawing";
import { NUDGE_BIG_PX, NUDGE_PX } from "./edits";

/**
 * The keys of a graph's canvas (Graph 0.8.1 board, frame 20) as one pure table, so the whole key
 * matrix is tested without a canvas. The keys are defined once in the shortcut registry
 * (shortcuts/builtins.ts, area "graph"), so the help, menus and tooltips show what is matched
 * here. The M3 keys keep their meaning (Enter, Space, S, P, Escape, + - 0, arrows); new actions
 * only take free keys; nothing here takes a global shortcut: "/" and "?" are never handled, "E"
 * opens the panel editor, Ctrl+F stays the browser's search, Shift+L is the layout's
 * "Rearrange", and the second key of a "t" sequence (t then ←, →, z, c or v) goes to the time
 * range.
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
  /** The physical key, for layouts without Latin letters (registry.ts). */
  code?: string | undefined;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Part of an input method composition: never the canvas's key (lib/ime.ts). */
  isComposing?: boolean;
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

/** The canvas's actions without parameters, by their shortcut in the registry, in match order. */
const SIMPLE: readonly (readonly [ShortcutId, CanvasKeyAction])[] = [
  ["graph.undo", { kind: "undo" }],
  ["graph.redo", { kind: "redo" }],
  ["graph.selectAll", { kind: "selectAll" }],
  ["graph.invert", { kind: "invert" }],
  ["graph.menu", { kind: "menu" }],
  ["graph.menuKey", { kind: "menu" }],
  ["graph.open", { kind: "activate" }],
  ["graph.select", { kind: "toggleSelect" }],
  ["graph.pin", { kind: "pin" }],
  ["graph.only", { kind: "only" }],
  ["graph.hide", { kind: "hide" }],
  ["graph.showAll", { kind: "showAll" }],
  ["graph.neighbours", { kind: "neighbours" }],
  ["graph.edges", { kind: "walk" }],
  ["graph.toolPointer", { kind: "tool", tool: "pointer" }],
  ["graph.toolRect", { kind: "tool", tool: "rect" }],
  ["graph.toolLasso", { kind: "tool", tool: "lasso" }],
  ["graph.search", { kind: "search" }],
  ["graph.card", { kind: "card" }],
  ["graph.minimap", { kind: "minimap" }],
  ["graph.view", { kind: "view" }],
  ["graph.zoomIn", { kind: "zoom", factor: 1.5 }],
  ["graph.zoomOut", { kind: "zoom", factor: 1 / 1.5 }],
  ["graph.zoomReset", { kind: "fit" }],
];

/** The press as the registry's matcher reads it. */
function asEvent(press: KeyPress) {
  return { ...press, code: press.code ?? "" };
}

/** The canvas action for a key, or null when the key is not the canvas's to take. */
export function canvasKey(
  press: KeyPress,
  mode: KeyMode,
  platform: Platform = currentPlatform(),
): CanvasKeyAction | null {
  if (press.isComposing === true) return null;
  const event = asEvent(press);
  const matches = (id: ShortcutId) => matchesShortcut(id, event, platform);
  const direction = DIRECTIONS[press.key];
  if (direction !== undefined && (matches("graph.nudge") || matches("graph.nudgeBig"))) {
    const step = press.shiftKey ? NUDGE_BIG_PX : NUDGE_PX;
    return {
      kind: "nudge",
      dx: direction === "left" ? -step : direction === "right" ? step : 0,
      dy: direction === "up" ? -step : direction === "down" ? step : 0,
    };
  }
  // While a mode runs, the arrows (with Shift for larger steps), Enter and Space are its own.
  const plainish = !(press.ctrlKey || press.metaKey || press.altKey);
  if (plainish && mode.rect && (direction !== undefined || press.key === "Enter")) {
    return { kind: "area", key: direction ?? "enter", big: press.shiftKey };
  }
  if (plainish && mode.walking && direction !== undefined) {
    return { kind: "walkMove", by: direction === "left" || direction === "up" ? -1 : 1 };
  }
  if (mode.walking && matches("graph.select")) return { kind: "walkSelect" };
  if (direction !== undefined && matches("graph.next")) return { kind: "move", direction };
  for (const [id, action] of SIMPLE) {
    if (matches(id)) return action;
  }
  return null;
}

/**
 * Follows the "t" sequences of the time range: a plain "t" arms it, and the key after it within
 * SEQUENCE_MS is the time range's when it is one of its second keys. `pass` says the canvas
 * leaves the key alone.
 */
export function timeSequence(
  platform: Platform = currentPlatform(),
): (press: KeyPress & { timeStamp: number }) => boolean {
  let armedAt = Number.NEGATIVE_INFINITY;
  return (press) => {
    const event = asEvent(press);
    const step = (n: number) =>
      TIME_SEQUENCES.some(([id]) => matchesSequenceStep(id, n, event, platform));
    const armed = press.timeStamp - armedAt <= SEQUENCE_MS;
    if (armed && step(1)) {
      armedAt = Number.NEGATIVE_INFINITY;
      return true;
    }
    if (step(0)) {
      armedAt = press.timeStamp;
      return true;
    }
    armedAt = Number.NEGATIVE_INFINITY;
    return false;
  };
}

/** The parts of a keyboard event the canvas keys read. */
export function pressOf(event: KeyPress & Parameters<typeof isComposingKey>[0]): KeyPress {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: isComposingKey(event),
  };
}
