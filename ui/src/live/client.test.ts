import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryOutcome } from "../api/generated/shapes";
import { FakeSocket } from "../test/fakeLive";
import {
  HIDDEN_GRACE_MS,
  LINGER_MS,
  LiveClient,
  type LiveListener,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  STABLE_MS,
} from "./client";

const OUTCOME: Record<string, QueryOutcome> = {
  A: { result: { shape: "frame", frame: { fields: [] } } },
};

function listener() {
  return {
    onResult: vi.fn<LiveListener["onResult"]>(),
    onStatus: vi.fn<LiveListener["onStatus"]>(),
    onError: vi.fn<LiveListener["onError"]>(),
  };
}

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("LiveClient", () => {
  let sockets: FakeSocket[];
  let now: number;
  let client: LiveClient;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    sockets = [];
    now = 1_000_000;
    client = new LiveClient("/api/orgs/o1/live", {
      open: (path) => {
        const socket = new FakeSocket(path);
        sockets.push(socket);
        return socket;
      },
      // The middle of the jitter: every wait is three quarters of the grown one.
      random: () => 0.5,
      now: () => now,
    });
  });

  afterEach(() => {
    client.dispose();
    vi.useRealTimers();
  });

  const last = () => sockets.at(-1) as FakeSocket;

  it("opens one socket for every subscription and subscribes each once it is open", () => {
    client.subscribe(
      { panel: { dashboardId: "d", panelId: "p1" }, lastMs: 60_000, variables: {} },
      listener(),
    );
    client.subscribe(
      { panel: { dashboardId: "d", panelId: "p2" }, lastMs: 60_000, variables: {} },
      listener(),
    );
    expect(sockets).toHaveLength(1);
    expect(last().path).toBe("/api/orgs/o1/live");
    expect(last().sent).toEqual([]);
    expect(client.state.state).toBe("connecting");
    last().open();
    expect(client.state.state).toBe("open");
    expect(last().subscribes()).toEqual([
      {
        type: "subscribe",
        id: "s1",
        panel: { dashboardId: "d", panelId: "p1" },
        lastMs: 60_000,
        variables: {},
      },
      {
        type: "subscribe",
        id: "s2",
        panel: { dashboardId: "d", panelId: "p2" },
        lastMs: 60_000,
        variables: {},
      },
    ]);
    // A subscription made while the socket is open goes out at once.
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    expect(last().subscribes().at(-1)).toMatchObject({ id: "s3" });
    expect(sockets).toHaveLength(1);
  });

  it("hands each feed's status and results to every subscription following it", () => {
    const a = listener();
    const b = listener();
    const c = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, b);
    client.subscribe({ queries: [], lastMs: 2000, variables: {} }, c);
    last().open();
    last().receive({ type: "subscribed", id: "s1", feed: "f1" });
    last().receive({ type: "subscribed", id: "s2", feed: "f1" });
    last().receive({ type: "subscribed", id: "s3", feed: "f2" });
    last().receive({
      type: "status",
      feed: "f1",
      mode: "poll",
      refreshMs: 30_000,
      reason: "live.source_unsupported",
    });
    last().receive({ type: "result", feed: "f1", at: 42, results: OUTCOME });
    expect(a.onStatus).toHaveBeenCalledWith({
      mode: "poll",
      refreshMs: 30_000,
      reason: "live.source_unsupported",
    });
    expect(a.onResult).toHaveBeenCalledWith(OUTCOME, 42);
    expect(b.onResult).toHaveBeenCalledWith(OUTCOME, 42);
    expect(c.onResult).not.toHaveBeenCalled();
    expect(c.onStatus).not.toHaveBeenCalled();
    // A moved subscription follows its new feed only.
    last().receive({ type: "subscribed", id: "s2", feed: "f3" });
    last().receive({ type: "result", feed: "f1", at: 43, results: OUTCOME });
    expect(a.onResult).toHaveBeenCalledTimes(2);
    expect(b.onResult).toHaveBeenCalledTimes(1);
  });

  it("ends a subscription the server refused and leaves the others running", () => {
    const a = listener();
    const b = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, b);
    last().open();
    last().receive({ type: "subscribed", id: "s1", feed: "f1" });
    last().receive({ type: "subscribed", id: "s2", feed: "f1" });
    const refused = { code: "forbidden" as const, message: "no", reason: "live.forbidden" };
    last().receive({ type: "error", id: "s1", error: refused });
    // A message the server did not understand ends nothing.
    last().receive({
      type: "error",
      error: { code: "validation", message: "?", reason: "live.invalid_message" },
    });
    last().receive({ type: "result", feed: "f1", at: 1, results: OUTCOME });
    expect(a.onError).toHaveBeenCalledWith(refused);
    expect(a.onResult).not.toHaveBeenCalled();
    expect(b.onResult).toHaveBeenCalledTimes(1);
    expect(b.onError).not.toHaveBeenCalled();
    // An ended subscription is not subscribed again after a reconnect.
    last().drop(1006);
    vi.advanceTimersByTime(RETRY_MAX_MS);
    last().open();
    expect(
      last()
        .subscribes()
        .map((m) => m.id),
    ).toEqual(["s2"]);
  });

  it("unsubscribes, and closes the socket shortly after the last subscription ends", () => {
    const end1 = client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    const end2 = client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    last().open();
    end1();
    expect(last().sent.at(-1)).toEqual({ type: "unsubscribe", id: "s1" });
    end2();
    expect(last().closedWith).toBeUndefined();
    // One that follows at once keeps the socket.
    const end3 = client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    vi.advanceTimersByTime(LINGER_MS);
    expect(last().closedWith).toBeUndefined();
    end3();
    vi.advanceTimersByTime(LINGER_MS);
    expect(last().closedWith).toBe(1000);
    expect(client.state.state).toBe("idle");
    // The next subscription opens a new socket.
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    expect(sockets).toHaveLength(2);
  });

  it.each([
    [1001, "live.shutting_down"],
    [4009, "live.slow_client"],
    [4008, "live.idle_timeout"],
    [1006, ""],
  ])(
    "reconnects after close %i %s with growing, jittered waits and subscribes again",
    (code, reason) => {
      const a = listener();
      client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
      last().open();
      if (reason !== "") {
        last().receive({ type: "closing", error: { code: "busy", message: "bye", reason } });
      }
      last().drop(code, reason);
      expect(client.state).toEqual({
        state: "retrying",
        reason: reason === "" ? undefined : reason,
      });
      // First wait: half the base plus half of a random half (0.5): 0.75 of the base.
      vi.advanceTimersByTime(RETRY_BASE_MS * 0.75 - 1);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
      // The attempt fails without opening: the next wait is twice as long.
      last().drop(1006);
      vi.advanceTimersByTime(RETRY_BASE_MS * 1.5 - 1);
      expect(sockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(3);
      last().open();
      expect(last().subscribes()).toHaveLength(1);
      expect(a.onError).not.toHaveBeenCalled();
    },
  );

  it("caps the wait and starts small again after a connection that held", () => {
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    for (let i = 0; i < 10; i += 1) {
      last().drop(1006);
      vi.advanceTimersByTime(RETRY_MAX_MS);
    }
    const before = sockets.length;
    last().drop(1006);
    vi.advanceTimersByTime(RETRY_MAX_MS * 0.75 - 1);
    expect(sockets).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(before + 1);
    last().open();
    now += STABLE_MS;
    last().drop(1001, "live.shutting_down");
    vi.advanceTimersByTime(RETRY_BASE_MS * 0.75);
    expect(sockets).toHaveLength(before + 2);
  });

  it.each([
    [4001, "live.unauthenticated", "unauthenticated"],
    [4003, "live.forbidden", "forbidden"],
  ])("stops on close %i %s and tells every subscription", (code, reason, errorCode) => {
    const a = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
    last().open();
    last().drop(code, reason);
    expect(client.state).toEqual({ state: "stopped", reason });
    expect(a.onError).toHaveBeenCalledWith(expect.objectContaining({ code: errorCode, reason }));
    vi.advanceTimersByTime(RETRY_MAX_MS * 2);
    expect(sockets).toHaveLength(1);
    // A new subscription hears the stop at once and opens nothing.
    const b = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, b);
    expect(b.onError).toHaveBeenCalledWith(expect.objectContaining({ reason }));
    expect(sockets).toHaveLength(1);
    // Turning live on again starts over.
    client.restart();
    expect(sockets).toHaveLength(2);
    last().open();
    expect(last().subscribes()).toHaveLength(2);
  });

  it("pauses while the tab is hidden and resumes when it is shown", () => {
    const a = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
    last().open();
    // A quick look elsewhere keeps the connection.
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    setVisibility("visible");
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(last().closedWith).toBeUndefined();
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(last().closedWith).toBe(1000);
    expect(client.state.state).toBe("paused");
    // Nothing reconnects while hidden, not even a new subscription.
    vi.advanceTimersByTime(RETRY_MAX_MS);
    client.subscribe({ queries: [], lastMs: 2000, variables: {} }, listener());
    expect(sockets).toHaveLength(1);
    setVisibility("visible");
    expect(sockets).toHaveLength(2);
    last().open();
    expect(
      last()
        .subscribes()
        .map((m) => m.id),
    ).toEqual(["s1", "s2"]);
    expect(a.onError).not.toHaveBeenCalled();
  });

  it("waits for a retry that falls into a hidden tab until the tab is shown", () => {
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    last().open();
    last().drop(1006);
    visibility = "hidden";
    vi.advanceTimersByTime(RETRY_MAX_MS);
    expect(sockets).toHaveLength(1);
    expect(client.state.state).toBe("paused");
    setVisibility("visible");
    expect(sockets).toHaveLength(2);
  });

  it("tells watchers when the connection state changes", () => {
    const seen: string[] = [];
    const stop = client.watch(() => seen.push(client.state.state));
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, listener());
    last().open();
    last().drop(1006);
    stop();
    vi.advanceTimersByTime(RETRY_MAX_MS);
    expect(seen).toEqual(["connecting", "open", "retrying"]);
  });

  it("ignores messages that are not JSON", () => {
    const a = listener();
    client.subscribe({ queries: [], lastMs: 1000, variables: {} }, a);
    last().open();
    last().onmessage?.(new MessageEvent("message", { data: "{" }));
    expect(a.onError).not.toHaveBeenCalled();
    expect(client.state.state).toBe("open");
  });
});
