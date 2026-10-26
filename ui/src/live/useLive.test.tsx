import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryOutcome } from "../api/generated/shapes";
import { installFakeLive } from "../test/fakeLive";
import type { LiveSpec } from "./client";
import { useLiveSubscription } from "./useLive";

let live: ReturnType<typeof installFakeLive>;

afterEach(() => {
  live.reset();
});

const SPEC: LiveSpec = { queries: [], lastMs: 1000, variables: {} };
const OUTCOME: Record<string, QueryOutcome> = {
  A: { result: { shape: "frame", frame: { fields: [] } } },
};

describe("useLiveSubscription", () => {
  it("hands each result the target its subscription started for, and starts anew for another", () => {
    live = installFakeLive();
    const seen: unknown[] = [];
    const { rerender } = renderHook(
      ({ target }: { target: string[] }) =>
        useLiveSubscription("o1", SPEC, target, (_results, _at, captured) => seen.push(captured)),
      { initialProps: { target: ["k", "1"] } },
    );
    const socket = live.last();
    act(() => socket.open());
    act(() => {
      socket.receive({ type: "subscribed", id: "s1", feed: "f1" });
      socket.receive({ type: "result", feed: "f1", at: 1, results: OUTCOME });
    });
    rerender({ target: ["k", "2"] });
    expect(socket.sent.slice(-2)).toEqual([
      { type: "unsubscribe", id: "s1" },
      { type: "subscribe", id: "s2", ...SPEC },
    ]);
    act(() => {
      socket.receive({ type: "subscribed", id: "s2", feed: "f1" });
      socket.receive({ type: "result", feed: "f1", at: 2, results: OUTCOME });
    });
    expect(seen).toEqual([
      ["k", "1"],
      ["k", "2"],
    ]);
  });

  it("forgets an error when the subscription starts again with the same spec", () => {
    live = installFakeLive();
    const onResult = vi.fn();
    const { result, rerender } = renderHook(
      ({ spec }: { spec: LiveSpec | null }) => useLiveSubscription("o1", spec, null, onResult),
      { initialProps: { spec: SPEC as LiveSpec | null } },
    );
    const socket = live.last();
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: "error",
        id: "s1",
        error: { code: "validation", message: "full", reason: "live.too_many_subscriptions" },
      }),
    );
    expect(result.current.error?.reason).toBe("live.too_many_subscriptions");
    // Off and on with the same spec: a new start, without the old error.
    rerender({ spec: null });
    expect(result.current.on).toBe(false);
    rerender({ spec: SPEC });
    expect(result.current.error).toBeUndefined();
    expect(socket.subscribes().at(-1)).toMatchObject({ id: "s2" });
  });

  it("clears an error once the subscription runs after all", () => {
    live = installFakeLive();
    const first = renderHook(() => useLiveSubscription("o1", SPEC, "a", vi.fn()));
    const second = renderHook(() =>
      useLiveSubscription("o1", { ...SPEC, lastMs: 2000 }, "b", vi.fn()),
    );
    const socket = live.last();
    act(() => socket.open());
    act(() =>
      socket.receive({
        type: "error",
        id: "s2",
        error: { code: "validation", message: "full", reason: "live.too_many_subscriptions" },
      }),
    );
    expect(second.result.current.error).toBeDefined();
    // The first one ends: the refused one takes its place and its feed reports.
    first.unmount();
    expect(socket.subscribes().at(-1)).toMatchObject({ id: "s2" });
    act(() => {
      socket.receive({ type: "subscribed", id: "s2", feed: "f2" });
      socket.receive({ type: "status", feed: "f2", mode: "poll", refreshMs: 5000 });
    });
    expect(second.result.current.error).toBeUndefined();
    expect(second.result.current.status?.mode).toBe("poll");
  });
});
