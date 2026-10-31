import type { AnyRouter, HistoryLocation } from "@tanstack/react-router";

/**
 * Asks the page's leave guards (`useBlocker`, `useLeaveGuard`) whether it may be left for `href`,
 * as a navigation there would: a guard with unsaved changes shows its own question and resolves
 * once the person answers. True when nothing holds the page or the person chose to leave.
 *
 * For a move that is no navigation of the router yet, such as signing out: the page must go
 * before the session ends, and the sign-in page refuses to open while it is still valid.
 */
export async function mayLeave(router: AnyRouter, href: string): Promise<boolean> {
  const url = new URL(href, window.location.origin);
  const next: HistoryLocation = {
    href: `${url.pathname}${url.search}${url.hash}`,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    state: { __TSR_index: router.history.location.state.__TSR_index + 1, key: "", __TSR_key: "" },
  };
  for (const blocker of router.history._getBlockers()) {
    const blocked = await blocker.blockerFn({
      currentLocation: router.history.location,
      nextLocation: next,
      action: "PUSH",
    });
    if (blocked) {
      return false;
    }
  }
  return true;
}
