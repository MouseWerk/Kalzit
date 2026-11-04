import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, shareUrl } from "./share";

describe("sharing the Explore state", () => {
  const state = {
    orgId: "o1",
    datasourceId: "ds-mongo",
    query: { collection: "orders", pipeline: [{ $match: { status: "geöffnet" } }] },
    range: { from: "now-7d", to: "now" },
    steps: [{ id: "s1", type: "toFrame", frame: "A", columns: [{ path: "status" }] }],
    panel: "table",
  };

  it("keeps the state through the link, umlauts included", () => {
    const value = encodeShare(state);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(value)).toEqual(state);
  });

  it("refuses a damaged or newer link instead of guessing", () => {
    expect(decodeShare("not base64 at all!")).toBeNull();
    expect(decodeShare(btoa(JSON.stringify({ v: 2, o: "o1" })))).toBeNull();
    expect(decodeShare(btoa(JSON.stringify({ v: 1, o: "o1", d: "x" })))).toBeNull();
  });

  it("links a saved analysis without changes by its id", () => {
    expect(shareUrl("https://kalzit.test", { analysis: "an1" })).toBe(
      "https://kalzit.test/explore?analysis=an1",
    );
    expect(shareUrl("https://kalzit.test", { share: "abc" })).toBe(
      "https://kalzit.test/explore?share=abc",
    );
  });
});
