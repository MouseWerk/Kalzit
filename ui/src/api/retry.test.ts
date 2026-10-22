import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { BUSY_RETRY } from "./retry";

describe("retries of data source queries", () => {
  const busy = new ApiError("busy", 503, "busy", undefined, { error: { code: "busy" } }, 2000);
  it("tries again on Kalzit's own busy answer, after its Retry-After", () => {
    expect(BUSY_RETRY.retry(0, busy)).toBe(true);
    expect(BUSY_RETRY.retryDelay(1, busy)).toBe(2000);
    expect(BUSY_RETRY.retry(2, busy)).toBe(false);
  });

  it("does not ask a failing source again, nor repeat a bare 503", () => {
    const bare = new ApiError("busy", 503, "Service Unavailable", undefined, "<html>");
    expect(BUSY_RETRY.retry(0, bare)).toBe(false);
    expect(BUSY_RETRY.retry(0, new ApiError("internal", 500, "boom"))).toBe(false);
    expect(BUSY_RETRY.retry(0, new ApiError("datasource_error", 422, "down"))).toBe(false);
    expect(BUSY_RETRY.retry(0, new ApiError("network", 0, "offline"))).toBe(false);
  });
});
