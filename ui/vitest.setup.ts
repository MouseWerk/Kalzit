import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { loadAllLanguages, setLanguage } from "./src/i18n/i18n";
import { setTimeZone, setWeekStart } from "./src/lib/timeSettings";
import { dismissToast } from "./src/lib/toasts";
import { resetInputModality } from "./src/shell/inputModality";
import { finishConsoleGuard, startConsoleGuard } from "./src/test/console";
import { setTheme } from "./src/theme/theme";

// jsdom has no layout and reports scrollTo as "not implemented"; the router's scroll restoration
// calls it on every navigation. Scrolling has no observable effect without layout anyway.
window.scrollTo = () => undefined;

// The app loads a language's catalog when it is first shown; tests switch languages at will and
// expect the texts at once, so both are loaded before any test runs.
await loadAllLanguages();

beforeEach(() => {
  startConsoleGuard();
  setLanguage("en");
  setTheme("system");
  setTimeZone(null);
  setWeekStart(null);
  dismissToast();
  resetInputModality();
  // Setting the defaults above stores them; start every test with nothing remembered.
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  finishConsoleGuard();
});
