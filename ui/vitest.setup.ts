import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setLanguage } from "./src/i18n/i18n";
import { finishConsoleGuard, startConsoleGuard } from "./src/test/console";
import { setTheme } from "./src/theme/theme";

// jsdom has no layout and reports scrollTo as "not implemented"; the router's scroll restoration
// calls it on every navigation. Scrolling has no observable effect without layout anyway.
window.scrollTo = () => undefined;

// The data areas load their pages lazily (features/<area>/routes.tsx). Loading them here, before
// any test runs, keeps a test's first navigation from waiting on a cold module transform, which
// let the first findBy of a test time out now and then.
await Promise.all([
  import("./src/features/dashboards/DashboardsPage"),
  import("./src/features/dashboards/DashboardPage"),
  import("./src/features/dashboards/TrashPage"),
  import("./src/features/dashboards/VersionsPage"),
  import("./src/features/datasources/DataSourcesPage"),
  import("./src/features/datasources/DataSourceForm"),
  import("./src/features/explore/ExplorePage"),
]);

beforeEach(() => {
  startConsoleGuard();
  setLanguage("en");
  setTheme("system");
  // Setting the defaults above stores them; start every test with nothing remembered.
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  finishConsoleGuard();
});
