import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setLanguage } from "./src/i18n/i18n";
import { dismissToast } from "./src/lib/toasts";
import { setTimeZone, setWeekStart } from "./src/preferences/preferences";
import { resetInputModality } from "./src/shell/inputModality";
import { finishConsoleGuard, startConsoleGuard } from "./src/test/console";
import { setTheme } from "./src/theme/theme";

// jsdom has no layout and reports scrollTo as "not implemented"; the router's scroll restoration
// calls it on every navigation. Scrolling has no observable effect without layout anyway.
window.scrollTo = () => undefined;

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
});

afterEach(() => {
  cleanup();
  finishConsoleGuard();
});
