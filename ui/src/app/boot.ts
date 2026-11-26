import type { AppRouter } from "./router";

/**
 * The longest the boot state of index.html stays, whatever happens: a page that never resolves
 * shows the router's own pending and error pages rather than hiding behind it.
 */
export const BOOT_LIMIT_MS = 15_000;

/** Takes the boot state of index.html (#boot) away; safe to call more than once. */
export function dismissBoot(): void {
  document.getElementById("boot")?.remove();
}

/**
 * Keeps the boot state until the router has rendered its first page (a redirect to sign-in or
 * setup included), so the screen goes from the boot state straight to a page, never through an
 * empty canvas.
 */
export function dismissBootWhenRendered(router: AppRouter): void {
  if (document.getElementById("boot") === null) {
    return;
  }
  const limit = window.setTimeout(done, BOOT_LIMIT_MS);
  const unsubscribe = router.subscribe("onRendered", done);
  function done() {
    window.clearTimeout(limit);
    unsubscribe();
    dismissBoot();
  }
}
