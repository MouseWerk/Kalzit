import { afterEach, describe, expect, it } from "vitest";
import {
  applyDefaultTheme,
  DARK_VARIANT_STORAGE_KEY,
  getDarkVariant,
  getLightVariant,
  LIGHT_VARIANT_STORAGE_KEY,
  setDarkVariant,
  setLightVariant,
  setTheme,
} from "./theme";

afterEach(() => {
  setTheme("system");
  setLightVariant("light");
  setDarkVariant("dark");
  window.localStorage.clear();
});

describe("theme variants", () => {
  it("puts both variants on the document and remembers them, apart from the mode", () => {
    setTheme("dark");
    setLightVariant("paper");
    setDarkVariant("night");
    const root = document.documentElement;
    expect([root.dataset.theme, root.dataset.light, root.dataset.dark]).toEqual([
      "dark",
      "paper",
      "night",
    ]);
    expect(window.localStorage.getItem(LIGHT_VARIANT_STORAGE_KEY)).toBe("paper");
    expect(window.localStorage.getItem(DARK_VARIANT_STORAGE_KEY)).toBe("night");
  });

  it("applies the server's default variants only where this browser chose none", () => {
    window.localStorage.clear();
    setDarkVariant("graphite");
    window.localStorage.removeItem(LIGHT_VARIANT_STORAGE_KEY);
    applyDefaultTheme("system", "calcite", "night");
    expect(getLightVariant()).toBe("calcite");
    // The stored choice wins over the default.
    expect(getDarkVariant()).toBe("graphite");
    // A default is applied, never remembered, so a later default still reaches the visitor.
    expect(window.localStorage.getItem(LIGHT_VARIANT_STORAGE_KEY)).toBeNull();
  });

  it("ignores values that are no variant of that side", () => {
    window.localStorage.clear();
    applyDefaultTheme("system", "night", "paper");
    expect([getLightVariant(), getDarkVariant()]).toEqual(["light", "dark"]);
  });
});
