import { QueryClient } from "@tanstack/react-query";
import { type AnyRoute, createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, createApp } from "../app/app";
import { createAppRouter } from "../app/router";
import { GUIDE_SOURCES } from "../help/HelpPage";
import { getPanel } from "../panels/registry";

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

// The help route's guide pages are chunks of their own too (src/help/HelpPage.tsx), loaded once
// here for the same reason: under CI load even a module import waits on the test server.
await Promise.all(
  Object.values(GUIDE_SOURCES).flatMap((pages) => Object.values(pages).map((load) => load())),
);

/**
 * Loads the code of lazy panel types (src/panels/lazy.tsx) before a test draws them, for the same
 * reason: under CI load the cold chunk of a graph panel can take longer than a test waits for
 * what the panel shows.
 */
export async function preloadPanels(...types: string[]): Promise<void> {
  await Promise.all(
    types.map((type) => {
      const component = getPanel(type)?.Panel as { preload?: () => Promise<unknown> } | undefined;
      if (component?.preload === undefined) {
        throw new Error(`panel type ${type} does not load lazily`);
      }
      return component.preload();
    }),
  );
}

/**
 * Renders the whole app (router, guards, query cache) at `path`, without retries unless a test
 * is about them.
 */
export function renderApp(path: string, options: { retry?: boolean } = {}) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp({ history, retry: options.retry ?? false });
  const user = userEvent.setup();
  const view = render(<App app={app} />);
  const location = () => app.router.state.location;
  return { app, user, view, location };
}
