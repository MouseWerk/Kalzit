import { QueryClient } from "@tanstack/react-query";
import { type AnyRoute, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, createApp } from "../app/app";
import { createAppRouter } from "../app/router";

/**
 * Pages that load lazily (`lazyRouteComponent`) are loaded once when this helper is imported, so
 * the first navigation of a test never waits on a cold module transform, which CI always has.
 * Read from the route tree, so a new lazy page is covered without listing it here.
 */
async function preloadLazyPages(): Promise<string[]> {
  const router = createAppRouter(new QueryClient(), createMemoryHistory());
  const routes = Object.values(router.routesById as Record<string, AnyRoute>);
  const lazy = routes.filter(
    (route) =>
      typeof (route.options.component as { preload?: unknown } | undefined)?.preload === "function",
  );
  await Promise.all(
    lazy.map((route) => (route.options.component as { preload: () => Promise<void> }).preload()),
  );
  return lazy.map((route) => route.id);
}

/** The ids of the lazy pages loaded before any test of a file runs. */
export const PRELOADED_PAGES = await preloadLazyPages();

/** Renders the whole app (router, guards, query cache) at `path`, without retries. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp({ history, retry: false });
  const user = userEvent.setup();
  const view = render(<App app={app} />);
  const location = () => app.router.state.location;
  return { app, user, view, location };
}
