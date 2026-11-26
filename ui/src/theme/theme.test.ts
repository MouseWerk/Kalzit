import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyDefaultTheme,
  DARK_VARIANT_STORAGE_KEY,
  DEFAULT_DARK_CACHE_KEY,
  DEFAULT_LIGHT_CACHE_KEY,
  getDarkVariant,
  getLightVariant,
  isPreSignInPath,
  LIGHT_VARIANT_STORAGE_KEY,
  setDarkVariant,
  setLightVariant,
  setTheme,
} from "./theme";

afterEach(() => {
  window.history.replaceState(null, "", "/");
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

  it("applies the server's default variants before sign-in, over a variant an account stored", () => {
    window.localStorage.clear();
    setDarkVariant("graphite");
    window.localStorage.removeItem(LIGHT_VARIANT_STORAGE_KEY);
    window.history.replaceState(null, "", "/login");
    applyDefaultTheme("system", "calcite", "night");
    expect(getLightVariant()).toBe("calcite");
    // Variants are chosen only in the account settings, so the default wins before sign-in.
    expect(getDarkVariant()).toBe("night");
    // No preference is written: the account's stored variant stays for its next visit, and a
    // later default still reaches the visitor. The defaults go to their cache keys only.
    expect(window.localStorage.getItem(LIGHT_VARIANT_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(DARK_VARIANT_STORAGE_KEY)).toBe("graphite");
    expect(window.localStorage.getItem(DEFAULT_LIGHT_CACHE_KEY)).toBe("calcite");
    expect(window.localStorage.getItem(DEFAULT_DARK_CACHE_KEY)).toBe("night");
  });

  it("keeps a stored variant on other pages, such as help for someone signed in", () => {
    setDarkVariant("graphite");
    window.history.replaceState(null, "", "/help/getting-started");
    applyDefaultTheme("system", "calcite", "night");
    expect(getDarkVariant()).toBe("graphite");
    // Nothing stored on that side: the default applies, as before.
    expect(getLightVariant()).toBe("calcite");
  });

  it("ignores values that are no variant of that side", () => {
    window.localStorage.clear();
    applyDefaultTheme("system", "night", "paper");
    expect([getLightVariant(), getDarkVariant()]).toEqual(["light", "dark"]);
    expect(window.localStorage.getItem(DEFAULT_LIGHT_CACHE_KEY)).toBeNull();
  });

  it("knows the pages before sign-in and the paths below them", () => {
    expect(isPreSignInPath("/login")).toBe(true);
    expect(isPreSignInPath("/anmelden/lokal")).toBe(true);
    expect(isPreSignInPath("/reset-password")).toBe(true);
    expect(isPreSignInPath("/loginx")).toBe(false);
    expect(isPreSignInPath("/help/getting-started")).toBe(false);
    expect(isPreSignInPath("/")).toBe(false);
  });
});

describe("the first paint on a page before sign-in", () => {
  // An account's variant stored in this browser, and the server's default last seen here.
  function storeBoth() {
    window.localStorage.setItem(LIGHT_VARIANT_STORAGE_KEY, "paper");
    window.localStorage.setItem(DARK_VARIANT_STORAGE_KEY, "graphite");
    window.localStorage.setItem(DEFAULT_LIGHT_CACHE_KEY, "calcite");
    window.localStorage.setItem(DEFAULT_DARK_CACHE_KEY, "night");
  }
  const boot = readFileSync(resolve(__dirname, "../../public/theme-boot.js"), "utf8");
  const runBoot = () => new Function(boot)();

  it("shows the cached default in the boot script, before branding loads", () => {
    storeBoth();
    window.history.replaceState(null, "", "/login");
    runBoot();
    const root = document.documentElement;
    expect([root.dataset.light, root.dataset.dark]).toEqual(["calcite", "night"]);
    // Elsewhere the account's own variants.
    window.history.replaceState(null, "", "/");
    runBoot();
    expect([root.dataset.light, root.dataset.dark]).toEqual(["paper", "graphite"]);
  });

  it("keeps the cached default when the theme module starts, before branding loads", async () => {
    storeBoth();
    window.history.replaceState(null, "", "/login");
    vi.resetModules();
    const fresh = await import("./theme");
    expect([fresh.getLightVariant(), fresh.getDarkVariant()]).toEqual(["calcite", "night"]);
    expect(document.documentElement.dataset.dark).toBe("night");
    // The account's own variant stays stored.
    expect(window.localStorage.getItem(DARK_VARIANT_STORAGE_KEY)).toBe("graphite");
  });
});
