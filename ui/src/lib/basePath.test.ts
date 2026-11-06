import { afterEach, describe, expect, it } from "vitest";
import { basePath, resetBasePath, withBase, withoutBase } from "./basePath";

function setMeta(content: string | null) {
  for (const meta of document.querySelectorAll('meta[name="kalzit-base-path"]')) meta.remove();
  if (content !== null) {
    const meta = document.createElement("meta");
    meta.name = "kalzit-base-path";
    meta.content = content;
    document.head.append(meta);
  }
  resetBasePath();
}

describe("base path", () => {
  afterEach(() => setMeta(null));

  it("is empty at the root, and paths stay as they are", () => {
    setMeta(null);
    expect(basePath()).toBe("");
    expect(withBase("/api/me")).toBe("/api/me");
    expect(withoutBase("/dashboards/x")).toBe("/dashboards/x");
  });

  it("puts the sub-path in front of server paths only", () => {
    setMeta("/tools/kalzit");
    expect(withBase("/api/me")).toBe("/tools/kalzit/api/me");
    expect(withBase("https://example.com/x")).toBe("https://example.com/x");
    expect(withBase("//example.com/x")).toBe("//example.com/x");
    expect(withoutBase("/tools/kalzit/dashboards/x")).toBe("/dashboards/x");
    expect(withoutBase("/tools/kalzit")).toBe("/");
    expect(withoutBase("/tools/kalzitx")).toBe("/tools/kalzitx");
  });

  it("ignores a value that is no plain path", () => {
    setMeta("javascript:alert(1)");
    expect(basePath()).toBe("");
    setMeta("/a/../b");
    expect(basePath()).toBe("");
  });
});
