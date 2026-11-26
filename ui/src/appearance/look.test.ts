import { describe, expect, it } from "vitest";
import { checkAccent } from "./contrast";
import { applyLook, DEFAULT_LOOK } from "./look";

describe("a custom accent saved before the theme variants", () => {
  // Holds 3:1 on Light and Dark (the check it was saved under), not on Paper.
  const older = "#8a8a8a";

  it("is refused as a new choice but still shows", () => {
    const check = checkAccent(older);
    expect(check?.passes).toBe(false);
    expect(check?.shows).toBe(true);
    const element = document.createElement("div");
    applyLook(element, { ...DEFAULT_LOOK, accent: older });
    expect(element.dataset.accent).toBe("custom");
    expect(element.style.getPropertyValue("--accent-custom")).toBe(older);
    expect(element.dataset.accentOn).toBe("dark");
  });

  it("falls back to copper only when it never held", () => {
    const element = document.createElement("div");
    applyLook(element, { ...DEFAULT_LOOK, accent: "#ffffff" });
    expect(element.dataset.accent).toBe("copper");
    expect(element.style.getPropertyValue("--accent-custom")).toBe("");
  });
});
