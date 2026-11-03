import { afterEach, describe, expect, it } from "vitest";
import { applyPreferences, type Preferences } from "../preferences/preferences";
import {
  catalogs,
  getLanguage,
  getSavedLanguage,
  loadLanguage,
  previewLanguage,
  setLanguage,
} from "./i18n";

// The setup loads both catalogs; these tests take German away again, so a switch to it waits
// for its download as it does in the browser.
function unloadGerman(): void {
  delete catalogs.de;
}

const PREFERENCES: Preferences = {
  language: "en",
  theme: null,
  timeZone: null,
  weekStart: null,
  startDashboard: null,
  showTips: true,
  seenTips: [],
  defaults: { language: "en", theme: "system" },
};

afterEach(async () => {
  await loadLanguage("de");
});

describe("switching to a language that is still loading", () => {
  it("keeps the saved switch when setup ends its preview right after saving", async () => {
    unloadGerman();
    // Setup previews the default language, saves it, and its preview ends (SetupPage onSuccess).
    previewLanguage("de");
    setLanguage("de");
    previewLanguage(null);
    expect(getLanguage()).toBe("en");
    await loadLanguage("de");
    expect(getLanguage()).toBe("de");
    expect(getSavedLanguage()).toBe("de");
  });

  it("lets the account's preference win over a pending choice made before signing in", async () => {
    unloadGerman();
    // German chosen on the sign-in page; the account prefers English.
    setLanguage("de");
    applyPreferences(PREFERENCES);
    await loadLanguage("de");
    expect(getLanguage()).toBe("en");
    expect(getSavedLanguage()).toBe("en");
  });

  it("does nothing for a language that already applies", () => {
    setLanguage("en");
    expect(getLanguage()).toBe("en");
    previewLanguage(null);
    expect(getLanguage()).toBe("en");
  });
});
