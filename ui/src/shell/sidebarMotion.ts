/**
 * The sidebar's slide between the column and the icon rail. The state change runs inside a
 * view transition: the browser snapshots the sidebar and the page before and after, and the
 * sidebar's edge glides while both cross-fade (shellUx.css, "Sidebar motion"). Nothing is laid
 * out again per frame, so heavy dashboards do not reflow during the slide.
 *
 * Without view transitions, or with reduced motion, the change is applied at once.
 */

/** Set on the root element while the slide runs; the transition names apply only then. */
export const SIDEBAR_MOTION_ATTRIBUTE = "data-sidebar-motion";

let latest: ViewTransition | null = null;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Runs `update` (which must apply the change synchronously) with the sidebar's slide. */
export function withSidebarMotion(update: () => void): void {
  const root = document.documentElement;
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    update();
    return;
  }
  root.setAttribute(SIDEBAR_MOTION_ATTRIBUTE, "");
  const transition = document.startViewTransition(update);
  latest = transition;
  // A skipped transition (the tab hidden, another one started) still applies the update. A
  // quick second toggle skips the first slide; only the latest one clears the attribute, so the
  // second keeps its names instead of falling back to a full-page cross-fade.
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (latest === transition) {
        latest = null;
        root.removeAttribute(SIDEBAR_MOTION_ATTRIBUTE);
      }
    });
}
