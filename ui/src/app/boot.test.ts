import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOT_LIMIT_MS, dismissBootWhenRendered } from "./boot";
import type { AppRouter } from "./router";

/** A router that only knows `subscribe`, with a way to send it the event. */
function fakeRouter() {
  const listeners = new Set<() => void>();
  const router = {
    subscribe: (event: string, listener: () => void) => {
      expect(event).toBe("onRendered");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AppRouter;
  const rendered = () => {
    for (const listener of [...listeners]) listener();
  };
  return { router, rendered, listeners };
}

function addBoot() {
  const boot = document.createElement("div");
  boot.id = "boot";
  document.body.append(boot);
}

describe("boot state", () => {
  afterEach(() => {
    document.getElementById("boot")?.remove();
    vi.useRealTimers();
  });

  it("stays until the first page has rendered, then goes and stops listening", () => {
    addBoot();
    const { router, rendered, listeners } = fakeRouter();
    dismissBootWhenRendered(router);
    expect(document.getElementById("boot")).not.toBeNull();
    rendered();
    expect(document.getElementById("boot")).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("goes after the limit when no page ever renders", () => {
    vi.useFakeTimers();
    addBoot();
    const { router, listeners } = fakeRouter();
    dismissBootWhenRendered(router);
    vi.advanceTimersByTime(BOOT_LIMIT_MS - 1);
    expect(document.getElementById("boot")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.getElementById("boot")).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("does nothing without a boot state (tests, or a page that never had one)", () => {
    const { router, listeners } = fakeRouter();
    dismissBootWhenRendered(router);
    expect(listeners.size).toBe(0);
  });
});
