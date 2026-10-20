import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, createApp } from "../app/app";

/** Renders the whole app (router, guards, query cache) at `path`, without retries. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp({ history, retry: false });
  const user = userEvent.setup();
  const view = render(<App app={app} />);
  const location = () => app.router.state.location;
  return { app, user, view, location };
}
