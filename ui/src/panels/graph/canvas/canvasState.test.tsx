import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyModel } from "../../../features/dashboards/model";
import { addDashboard } from "../../../features/dashboards/test/fakeDashboards";
import { installFakeServer, TEST_USER } from "../../../test/fakeServer";
import { EMPTY_VIEW_STATE, SAVE_DELAY_MS, usePanelViewState } from "../viewState";
import { CARD_VALUE_CHARS, cardText } from "./cardContent";
import { hide, mergeEdits, NO_EDITS, pin, pinUpTo, samePlaces } from "./edits";
import { type CanvasKeyAction, canvasKey, type KeyPress, timeSequence } from "./keys";
import { MINIMAP_HEIGHT, MINIMAP_WIDTH } from "./Minimap";
import { useViewEdits } from "./useViewEdits";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const plain = { rect: false, walking: false };
const kind = (action: CanvasKeyAction | null) => action?.kind ?? null;

describe("canvas keys", () => {
  it("keeps the M3 keys and gives new actions free keys only", () => {
    const matrix: [KeyPress, string | null][] = [
      [press("Enter"), "activate"],
      [press(" "), "toggleSelect"],
      [press("p"), "pin"],
      [press("s"), "only"],
      [press("+"), "zoom"],
      [press("-"), "zoom"],
      [press("0"), "fit"],
      [press("ArrowLeft"), "move"],
      [press("z", { ctrlKey: true }), "undo"],
      [press("Z", { ctrlKey: true, shiftKey: true }), "redo"],
      [press("z", { metaKey: true, shiftKey: true }), "redo"],
      [press("a", { ctrlKey: true }), "selectAll"],
      [press("i", { ctrlKey: true }), "invert"],
      [press("F10", { shiftKey: true }), "menu"],
      [press("ContextMenu"), "menu"],
      [press("h"), "hide"],
      [press("H", { shiftKey: true }), "showAll"],
      [press("n"), "neighbours"],
      [press("k"), "walk"],
      [press("v"), "tool"],
      [press("r"), "tool"],
      [press("l"), "tool"],
      [press("f"), "search"],
      [press("i"), "card"],
      [press("m"), "minimap"],
      [press("a"), "view"],
      // Never the canvas's: the palette, the help, the panel editor, the browser's search, the
      // layout's "Rearrange", and other modifiers.
      [press("/"), null],
      [press("?", { shiftKey: true }), null],
      [press("e"), null],
      [press("E", { shiftKey: true }), null],
      [press("t"), null],
      [press("f", { ctrlKey: true }), null],
      [press("L", { shiftKey: true }), null],
      [press("p", { ctrlKey: true }), null],
      [press("Escape"), null],
    ];
    for (const [key, expected] of matrix) {
      expect(kind(canvasKey(key, plain)), JSON.stringify(key)).toBe(expected);
    }
  });

  it("moves and pins with Alt+arrows, in larger steps with Shift", () => {
    expect(canvasKey(press("ArrowRight", { altKey: true }), plain)).toEqual({
      kind: "nudge",
      dx: 16,
      dy: 0,
    });
    expect(canvasKey(press("ArrowUp", { altKey: true, shiftKey: true }), plain)).toEqual({
      kind: "nudge",
      dx: 0,
      dy: -64,
    });
  });

  it("gives the arrows to the keyboard rectangle and to the walk along edges", () => {
    expect(
      canvasKey(press("ArrowDown", { shiftKey: true }), { rect: true, walking: false }),
    ).toEqual({ kind: "area", key: "down", big: true });
    expect(canvasKey(press("Enter"), { rect: true, walking: false })).toEqual({
      kind: "area",
      key: "enter",
      big: false,
    });
    expect(canvasKey(press("ArrowLeft"), { rect: false, walking: true })).toEqual({
      kind: "walkMove",
      by: -1,
    });
    expect(kind(canvasKey(press(" "), { rect: false, walking: true }))).toBe("walkSelect");
  });

  it("leaves the second key of a t sequence to the time range", () => {
    const passes = timeSequence();
    const at = (key: string, timeStamp: number, mods: Partial<KeyPress> = {}) =>
      passes({ ...press(key, mods), timeStamp });
    expect(at("t", 0)).toBe(true);
    expect(at("v", 100)).toBe(true);
    // Once only: the next v is the pointer tool again.
    expect(at("v", 200)).toBe(false);
    for (const key of ["z", "c", "ArrowLeft", "ArrowRight"]) {
      expect(at("t", 1000)).toBe(true);
      expect(at(key, 1100), key).toBe(true);
    }
    // Too late, another key, or with a modifier: the canvas's.
    expect(at("t", 5000)).toBe(true);
    expect(at("v", 7000)).toBe(false);
    expect(at("t", 8000)).toBe(true);
    expect(at("h", 8100)).toBe(false);
    expect(at("t", 9000)).toBe(true);
    expect(at("z", 9100, { ctrlKey: true })).toBe(false);
  });
});

describe("limits", () => {
  it("pins within the bound and returns the rest", () => {
    const full = pin(
      NO_EDITS,
      Array.from({ length: 199 }, (_, i) => `n${i}`),
    );
    const { edits, refused } = pinUpTo(
      full,
      ["n3", "a", "b", "c"],
      new Map([
        ["n3", [1, 1] as const],
        ["a", [2, 2] as const],
        ["b", [3, 3] as const],
      ]),
    );
    expect(edits.pins).toHaveLength(200);
    expect(refused).toEqual(["b", "c"]);
    // A node already pinned moves even at the bound.
    expect(edits.places.get("n3")).toEqual([1, 1]);
    expect(edits.places.has("b")).toBe(false);
  });

  it("cuts long values on the info card only", () => {
    expect(cardText("short")).toBe("short");
    const long = "x".repeat(CARD_VALUE_CHARS + 50);
    expect(cardText(long)).toBe(`${"x".repeat(CARD_VALUE_CHARS)}…`);
  });

  it("draws the minimap at the size its tokens give it", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../../../styles/tokens.css"), "utf8");
    const rem = (name: string) =>
      Number(new RegExp(`${name}:\\s*([\\d.]+)rem`).exec(tokens)?.[1] ?? Number.NaN) * 16;
    expect(rem("--size-graph-minimap-width")).toBe(MINIMAP_WIDTH);
    expect(rem("--size-graph-minimap-height")).toBe(MINIMAP_HEIGHT);
  });
});

describe("edits before the kept state arrives", () => {
  it("stay on top of it", () => {
    const kept = hide(pin(NO_EDITS, ["a"], new Map([["a", [1, 1] as const]])), ["x"]);
    const early = hide(pin(NO_EDITS, ["a", "b"], new Map([["a", [5, 5] as const]])), ["y"]);
    const merged = mergeEdits({ ...kept, released: ["b", "p"] }, early);
    expect(merged.pins).toEqual(["a", "b"]);
    expect(merged.places.get("a")).toEqual([5, 5]);
    expect(merged.hidden).toEqual(["x", "y"]);
    expect(merged.released).toEqual(["p"]);
    expect(mergeEdits(kept, NO_EDITS)).toBe(kept);
    expect(samePlaces(new Map([["a", [1, 2]]]), new Map([["a", [1, 2]]]))).toBe(true);
  });
});

describe("view edits hook", () => {
  function setup(editOptions?: (pinned: { id: string; x: number; y: number }[]) => void) {
    const steps: { label: string; undo: () => void; redo: () => void }[] = [];
    const hook = renderHook(
      ({ panel }) =>
        useViewEdits({
          panel,
          editOptions,
          record: (label, undo, redo) => steps.push({ label, undo, redo }),
        }),
      { initialProps: { panel: [{ id: "p", x: 1, y: 2 }] } },
    );
    return { hook, steps };
  }

  it("while viewing: changes are steps that undo and redo, and pins sit over the panel's", () => {
    const { hook, steps } = setup();
    act(() => {
      hook.result.current.change(
        pin(hook.result.current.now(), ["a"], new Map([["a", [3, 4]]])),
        "pin a",
      );
    });
    expect(hook.result.current.ids).toEqual(["p", "a"]);
    expect(steps.map((s) => s.label)).toEqual(["pin a"]);
    // The same edits again record nothing.
    act(() => {
      expect(hook.result.current.change(hook.result.current.now(), "nothing")).toBe(false);
    });
    act(() => steps[0]?.undo());
    expect(hook.result.current.ids).toEqual(["p"]);
    act(() => steps[0]?.redo());
    expect(hook.result.current.places.get("a")).toEqual([3, 4]);
  });

  it("keeps the places' identity when hiding changes nothing about them", () => {
    const { hook } = setup();
    const before = hook.result.current.places;
    act(() => {
      hook.result.current.change(hide(hook.result.current.now(), ["x"]), "hide x");
    });
    expect(hook.result.current.edits.hidden).toEqual(["x"]);
    expect(hook.result.current.places).toBe(before);
  });

  it("in the panel editor: writes the panel's pinned nodes and keeps hiding to itself", () => {
    const editOptions = vi.fn();
    const { hook, steps } = setup(editOptions);
    act(() => {
      hook.result.current.change(
        pin(hook.result.current.now(), ["q"], new Map([["q", [5, 6]]])),
        "pin q",
      );
    });
    expect(editOptions).toHaveBeenLastCalledWith([
      { id: "p", x: 1, y: 2 },
      { id: "q", x: 5, y: 6 },
    ]);
    act(() => {
      hook.result.current.change(hide(hook.result.current.now(), ["x"]), "hide x");
    });
    expect(hook.result.current.edits.hidden).toEqual(["x"]);
    act(() => steps[0]?.undo());
    expect(editOptions).toHaveBeenLastCalledWith([{ id: "p", x: 1, y: 2 }]);
  });

  it("restores the kept state under what changed before it arrived", () => {
    const { hook } = setup();
    act(() => {
      hook.result.current.change(hide(hook.result.current.now(), ["early"]), "hide early");
    });
    act(() => hook.result.current.restore({ ...EMPTY_VIEW_STATE, hidden: ["kept"] }));
    expect(hook.result.current.edits.hidden).toEqual(["kept", "early"]);
  });
});

describe("panel view state", () => {
  const view = { dashboardId: "d1", panelId: "p1" };
  const puts = (server: ReturnType<typeof installFakeServer>) =>
    server.calls.filter((call) => call.method === "PUT" && call.path.includes("/view-state"));

  it("sends once the viewer pauses, and what is still waiting when the panel goes", async () => {
    const server = installFakeServer({ signedIn: true, user: TEST_USER });
    addDashboard(server.areas.dashboards, "d1", {
      ...emptyModel("Shop"),
      panels: [
        {
          id: "p1",
          type: "network",
          title: "Graph",
          grid: { x: 0, y: 0, w: 12, h: 8 },
          targets: [],
          transformations: [],
          options: {},
          fieldConfig: {},
        },
      ],
    });
    const hook = renderHook(() => usePanelViewState("o1", view));
    await waitFor(() => expect(hook.result.current.settled).toBe(true));
    vi.useFakeTimers();
    try {
      act(() => hook.result.current.keep({ ...EMPTY_VIEW_STATE, pinned: ["a"] }));
      act(() => hook.result.current.keep({ ...EMPTY_VIEW_STATE, pinned: ["a", "b"] }));
      expect(puts(server)).toHaveLength(0);
      act(() => vi.advanceTimersByTime(SAVE_DELAY_MS));
      expect(puts(server)).toHaveLength(1);
      expect(puts(server)[0]?.body).toEqual({ pinned: ["a", "b"], selected: [] });
      // The same state again needs no request; a new one waits, and goes when the panel does.
      act(() => hook.result.current.keep({ ...EMPTY_VIEW_STATE, pinned: ["a", "b"] }));
      act(() => hook.result.current.keep({ ...EMPTY_VIEW_STATE, hidden: ["x"] }));
      hook.unmount();
      expect(puts(server)).toHaveLength(2);
      expect(puts(server)[1]?.body).toEqual({ pinned: [], selected: [], hidden: ["x"] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads and writes nothing without a dashboard panel (the panel editor's preview)", () => {
    const server = installFakeServer({ signedIn: true, user: TEST_USER });
    const hook = renderHook(() => usePanelViewState("o1", undefined));
    expect(hook.result.current.settled).toBe(true);
    act(() => hook.result.current.keep({ ...EMPTY_VIEW_STATE, pinned: ["a"] }));
    hook.unmount();
    expect(server.calls.filter((call) => call.path.includes("/view-state"))).toEqual([]);
  });
});
