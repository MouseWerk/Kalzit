import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESULT_GC_MS, useHeldResults } from "./resultCache";

describe("useHeldResults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: RESULT_GC_MS } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    client.setQueryData(["panel-data", "o1", "d1", "p1"], "orders");
    client.setQueryData(["panel-data", "o1", "d1", "p2"], "stock");
    client.setQueryData(["panel-data", "o1", "d2", "p9"], "elsewhere");
    return { client, wrapper };
  }

  it("keeps a dashboard's answers while nothing shows them, and lets them go after", () => {
    const { client, wrapper } = setup();
    const { rerender } = renderHook(
      ({ hold }) => useHeldResults(hold, ["panel-data", "o1", "d1"]),
      { wrapper, initialProps: { hold: true } },
    );
    vi.advanceTimersByTime(RESULT_GC_MS * 10);
    expect(client.getQueryData(["panel-data", "o1", "d1", "p1"])).toBe("orders");
    expect(client.getQueryData(["panel-data", "o1", "d1", "p2"])).toBe("stock");
    // Another dashboard's answers are not held.
    expect(client.getQueryData(["panel-data", "o1", "d2", "p9"])).toBeUndefined();

    rerender({ hold: false });
    vi.advanceTimersByTime(RESULT_GC_MS * 2);
    expect(client.getQueryData(["panel-data", "o1", "d1", "p1"])).toBeUndefined();
  });

  it("never runs a held query", () => {
    const { client, wrapper } = setup();
    const run = vi.fn(async () => "again");
    client.setQueryDefaults(["panel-data"], { queryFn: run });
    renderHook(() => useHeldResults(true, ["panel-data", "o1", "d1"]), { wrapper });
    vi.advanceTimersByTime(RESULT_GC_MS);
    expect(run).not.toHaveBeenCalled();
  });
});
