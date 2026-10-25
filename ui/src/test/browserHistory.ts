import { createBrowserHistory } from "@tanstack/react-router";

/**
 * A real browser history (jsdom's) with one page before `path`, so a test can press Back and the
 * router sees a popstate, as with the browser's or mouse's Back button. (The memory history does
 * not ask blockers about Back.) Call `destroy` at the end of the test.
 */
export function browserHistoryAt(before: string, path: string) {
  window.history.replaceState({ __TSR_index: 0, __TSR_key: "before" }, "", before);
  window.history.pushState({ __TSR_index: 1, __TSR_key: "page" }, "", path);
  const history = createBrowserHistory();
  return {
    history,
    destroy: () => {
      history.destroy();
      window.history.replaceState(null, "", "/");
    },
  };
}
