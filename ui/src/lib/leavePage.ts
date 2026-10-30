/**
 * Leaving the app for another page: a sign-in through a provider continues in the same tab, a
 * test sign-in opens a window of its own. Kept in one object so tests can watch where the page
 * would have gone (jsdom navigates nowhere).
 */
export const leavePage = {
  /** Loads `url` in this tab. */
  go(url: string): void {
    window.location.assign(url);
  },
  /** Opens `url` in a new window; false when the browser blocked it. */
  open(url: string): boolean {
    return window.open(url, "_blank") !== null;
  },
  /** Closes this window, which only works for a window a script opened. */
  close(): void {
    window.close();
  },
};
