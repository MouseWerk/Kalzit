import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { retryDelayMs, shouldRetryMutation, shouldRetryQuery } from "./app";

const busy = (retryAfterMs?: number) =>
  new ApiError("busy", 503, "busy", undefined, undefined, retryAfterMs);

describe("retries", () => {
  it("retries busy, network and internal queries a few times, nothing else", () => {
    expect(shouldRetryQuery(0, busy())).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("network", 0, ""))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("internal", 500, ""))).toBe(true);
    expect(shouldRetryQuery(0, new ApiError("forbidden", 403, ""))).toBe(false);
    expect(shouldRetryQuery(2, busy())).toBe(false);
  });

  it("retries a change only when the server said nothing changed", () => {
    expect(shouldRetryMutation(0, busy())).toBe(true);
    expect(shouldRetryMutation(0, new ApiError("internal", 500, ""))).toBe(false);
    expect(shouldRetryMutation(0, new ApiError("network", 0, ""))).toBe(false);
    expect(shouldRetryMutation(2, busy())).toBe(false);
  });

  it("waits as long as Retry-After asks, otherwise longer each time", () => {
    expect(retryDelayMs(0, busy(3000))).toBe(3000);
    expect(retryDelayMs(0, busy())).toBe(1000);
    expect(retryDelayMs(1, new ApiError("internal", 500, ""))).toBe(2000);
    expect(retryDelayMs(10, new ApiError("internal", 500, ""))).toBe(30_000);
  });
});
